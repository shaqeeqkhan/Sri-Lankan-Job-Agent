import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { sourceConfigs } from '../src/sources/load.ts';
import type { HttpClient, HttpResponse, Ladder, PageRequest, PageResult, SourceConfig, SourceContext, Tier } from '../src/sources/types.ts';
import { ROOT } from './helpers.ts';

/** A served value: a body (string for HTML/XML/text, anything else is sent as JSON), or a function of the request. */
export type Served = unknown | ((url: string, body?: unknown) => unknown);

export interface FixtureOptions {
  /** URL → HTML for `ctx.ladder.page()`. A value may also be a partial PageResult (e.g. `{ ok: false, block: … }`). */
  pages?: Record<string, string | Partial<PageResult>>;
  /** URL → body for `ctx.http.get()` / `ctx.http.postJson()`. Strings are served as text (sitemaps), the rest as JSON. */
  json?: Record<string, Served>;
  /** URL → HTTP status for `ctx.http` (default 200; unknown URLs get 404). */
  status?: Record<string, number>;
  /** A source id from config/sources.yml, or a SourceConfig (missing fields get test defaults). */
  source?: string | Partial<SourceConfig>;
  /** External ids an earlier scan already stored. */
  seen?: Iterable<string>;
  since?: Date | null;
  now?: Date;
  boards?: Record<string, unknown[]>;
  /** Tier reported for served pages (default T1). */
  tier?: Tier;
}

export interface FixtureCalls {
  pages: { url: string; req?: PageRequest }[];
  http: { method: 'GET' | 'POST'; url: string; body?: unknown }[];
}

export type FixtureContext = SourceContext & { calls: FixtureCalls; logs: string[] };

const DEFAULT_SOURCE: SourceConfig = {
  id: 'fixture',
  name: 'Fixture source',
  kind: 'board',
  hosts: ['example.lk'],
  enabled: true,
  slow: false,
  tiers: ['T0', 'T1', 'T5'],
  max_details: 300,
  delay_ms: 1500,
  options: {},
};

function resolveSource(s: FixtureOptions['source']): SourceConfig {
  if (typeof s === 'string') {
    const found = sourceConfigs(loadConfig(path.join(ROOT, 'config'), {})).find((c) => c.id === s);
    if (!found) throw new Error(`No source "${s}" in config/sources.yml`);
    return found;
  }
  return { ...DEFAULT_SOURCE, ...s };
}

/** Every <script type="application/ld+json"> block that parses. */
export function parseJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // A broken block is skipped, like the real ladder does.
    }
  }
  return out;
}

/**
 * A SourceContext for adapter tests: the ladder and http serve from in-memory maps, record every call,
 * and never touch the network. Unknown URLs: ladder → ok:false (404, block 'http'); http → status 404.
 */
export function fixtureContext(opts: FixtureOptions = {}): FixtureContext {
  const calls: FixtureCalls = { pages: [], http: [] };
  const logs: string[] = [];
  const tier = opts.tier ?? 'T1';
  const seen = new Set(opts.seen ?? []);

  const ladder: Ladder = {
    async page(url, req) {
      calls.pages.push({ url, req });
      const v = opts.pages?.[url];
      if (v === undefined) {
        return { ok: false, url, finalUrl: url, status: 404, html: '', jsonLd: [], tier, block: { reason: 'http', detail: 'HTTP 404 (no fixture)' } };
      }
      if (typeof v !== 'string') {
        return { ok: true, url, finalUrl: url, status: 200, html: '', jsonLd: [], tier, ...v };
      }
      if (req?.expect && !req.expect(v)) {
        return { ok: false, url, finalUrl: url, status: 200, html: '', jsonLd: [], tier, block: { reason: 'drift', detail: 'expect() returned false' } };
      }
      return { ok: true, url, finalUrl: url, status: 200, html: v, jsonLd: parseJsonLd(v), tier };
    },
    worstTier: () => tier,
  };

  function serve(method: 'GET' | 'POST', url: string, body?: unknown): HttpResponse {
    calls.http.push({ method, url, ...(body === undefined ? {} : { body }) });
    let v = opts.json?.[url];
    if (typeof v === 'function') v = (v as (u: string, b?: unknown) => unknown)(url, body);
    if (v === undefined) return { status: opts.status?.[url] ?? 404, url, headers: {}, text: '' };
    const isText = typeof v === 'string';
    return {
      status: opts.status?.[url] ?? 200,
      url,
      headers: { 'content-type': isText ? 'text/xml; charset=utf-8' : 'application/json' },
      text: isText ? (v as string) : JSON.stringify(v),
    };
  }
  const http: HttpClient = {
    get: async (url) => serve('GET', url),
    postJson: async (url, body) => serve('POST', url, body),
  };

  const now = opts.now ?? new Date('2026-11-15T04:00:00Z');
  return {
    source: resolveSource(opts.source),
    http,
    ladder,
    now: () => now,
    since: opts.since === undefined ? null : opts.since,
    seen: (id) => seen.has(id),
    log: (m) => void logs.push(m),
    boards: opts.boards ?? { workday: [], greenhouse: [], lever: [], ashby: [], smartrecruiters: [] },
    calls,
    logs,
  };
}

/** Reads `src/sources/<sourceId>/fixtures/<name>` as UTF-8. */
export function readFixture(sourceId: string, name: string, root = ROOT): string {
  return fs.readFileSync(path.join(root, 'src', 'sources', sourceId, 'fixtures', name), 'utf8');
}
