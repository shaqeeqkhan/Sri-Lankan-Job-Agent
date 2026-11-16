import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createContext, type Context } from '../src/context.ts';
import { inferApplyMethod } from '../src/jobs/normalize.ts';
import { upsertJob, type StoreInput } from '../src/jobs/store.ts';
import { ROOT } from '../src/paths.ts';

export { ROOT };

export function tempDir(prefix = 'slj-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A fetch that serves from a route table and records every request. Unknown URLs fail like a dead network. */
export function stubFetch(routes: Record<string, Route | string | object>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url.toString());
    const key = Object.keys(routes).find((k) => url.toString() === k) ?? Object.keys(routes).find((k) => url.toString().startsWith(k));
    if (!key) throw new TypeError(`fetch failed: ${url}`);
    const r = routes[key];
    if (typeof r === 'function') return (r as Route)(url, init);
    if (typeof r === 'string') return new Response(r, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return Response.json(r);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export function makeCtx(opts: { fetch?: typeof fetch; env?: Record<string, string>; now?: Date; configDir?: string } = {}): Context {
  const home = tempDir();
  return createContext({
    env: {
      PATH: process.env.PATH ?? '',
      SLJ_HOME: home,
      SLJ_CONFIG_DIR: opts.configDir ?? path.join(ROOT, 'config'),
      ...opts.env,
    },
    driver: 'test',
    fetch: opts.fetch ?? stubFetch({}).fetch,
    now: () => opts.now ?? new Date('2026-10-21T04:00:00Z'),
  });
}

export type SeedJob = Partial<StoreInput> & { ref?: string; source?: string; source_url?: string | null };

let seedSeq = 0;

/** A scraped-looking job, as a source adapter would hand it over. Each call without a `ref` gets a
 *  fresh ref, and the ref drives the posting id, source URL and apply address, so seeded jobs stay
 *  distinct under identity dedupe unless a test gives them the same values on purpose. */
export function sampleJob(over: SeedJob = {}): SeedJob {
  const ref = over.ref ?? `x-${++seedSeq}`;
  const key = ref.replace(/[^A-Za-z0-9]+/g, '-');
  return {
    ref,
    source: 'xpressjobs',
    source_url: `https://xpress.jobs/jobs/${key}`,
    platform: 'xpressjobs',
    external_id: key,
    title: 'Assistant Accountant',
    company: 'Lanka Biscuit Works (Pvt) Ltd',
    location: 'Colombo',
    closing_date: '2026-11-04',
    apply_email: `careers.${key.toLowerCase()}@lankabiscuit.example`,
    ...over,
  };
}

/** Store jobs straight through the store (the way `jobs scan` will), for tests that need a populated DB. */
export function seedJobs(ctx: Context, jobs: SeedJob[]): string[] {
  return jobs.map((j) => {
    const { ref, source, source_url, ...fields } = sampleJob(j);
    const input = { platform: 'other', ...fields, title: fields.title! } as StoreInput;
    input.apply_method = fields.apply_method ?? inferApplyMethod(input, input.platform !== 'other');
    return upsertJob(ctx.db(), input, { source: source!, source_ref: ref!, source_url }, ctx.now()).id;
  });
}

/** A real HTTP server, for tests that spawn the CLI as a separate process. */
export async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
