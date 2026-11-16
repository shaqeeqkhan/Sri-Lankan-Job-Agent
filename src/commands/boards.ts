import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { defineCommand, type Command } from '../registry.ts';
import { ATS_FAMILIES, boardFromUrl, parseBoardEntry, type AtsFamily, type BoardProbe } from '../sources/ats-common.ts';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../sources/types.ts';

const SOURCES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sources');
/** ATS APIs are paced at 0.5 s per host (PRD §7.2). */
const ATS_DELAY_MS = 500;

type ProbeFn = (http: HttpClient, entry: unknown) => Promise<BoardProbe>;

async function probeFor(family: AtsFamily): Promise<ProbeFn> {
  const mod = (await import(pathToFileURL(path.join(SOURCES_DIR, family, 'index.ts')).href)) as { probe?: ProbeFn };
  if (typeof mod.probe !== 'function') throw new SljError('INTERNAL', `src/sources/${family}/index.ts exports no probe().`);
  return mod.probe;
}

/** A minimal paced client over ctx.fetch, used only when src/sources/http.ts is not there. */
function fallbackClient(ctx: Context): HttpClient {
  const next = new Map<string, number>();
  async function pace(url: string, delay: number) {
    const host = new URL(url).host;
    const now = Date.now();
    const at = Math.max(now, next.get(host) ?? 0);
    next.set(host, at + delay);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  async function send(method: 'GET' | 'POST', url: string, body: unknown, opts?: HttpRequestOptions): Promise<HttpResponse> {
    await pace(url, opts?.delayMs ?? ATS_DELAY_MS);
    try {
      const res = await ctx.fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...opts?.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => void (headers[k.toLowerCase()] = v));
      return { status: res.status, url: res.url || url, headers, text: await res.text() };
    } catch (err) {
      throw new SljError('FETCH_FAILED', `Could not reach ${new URL(url).host}: ${(err as Error).message}`);
    }
  }
  return { get: (u, o) => send('GET', u, undefined, o), postJson: (u, b, o) => send('POST', u, b, o) };
}

/** The S1 client (src/sources/http.ts) when present, else the fallback. */
async function httpClient(ctx: Context): Promise<{ http: HttpClient; close(): Promise<void> }> {
  const file = path.join(SOURCES_DIR, 'http.ts');
  if (fs.existsSync(file)) {
    try {
      const mod = (await import(pathToFileURL(file).href)) as {
        createHttpClient?: (o: { fetch?: typeof fetch; defaultDelayMs?: number }) => HttpClient & { close?(): Promise<void> };
      };
      if (typeof mod.createHttpClient === 'function') {
        const http = mod.createHttpClient({ defaultDelayMs: ATS_DELAY_MS, ...(ctx.fetch === globalThis.fetch ? {} : { fetch: ctx.fetch }) });
        return { http, close: async () => void (await http.close?.()) };
      }
    } catch {
      // Fall through to the simple client.
    }
  }
  return { http: fallbackClient(ctx), close: async () => {} };
}

function resolveBoard(input: { board: string; family?: AtsFamily }): { family: AtsFamily; name: string } {
  const fromUrl = /^https?:\/\//i.test(input.board) ? boardFromUrl(input.board) : null;
  if (/^https?:\/\//i.test(input.board) && !fromUrl) {
    throw new SljError('INVALID_INPUT', `Not a Workday, Greenhouse, Lever, Ashby or SmartRecruiters board link: ${input.board}`);
  }
  if (fromUrl) {
    if (input.family && input.family !== fromUrl.family) {
      throw new SljError('INVALID_INPUT', `That link is a ${fromUrl.family} board, not ${input.family}.`);
    }
    return fromUrl;
  }
  if (!input.family) {
    throw new SljError('INVALID_INPUT', `Say which ATS the board is on (--family ${ATS_FAMILIES.join('|')}), or pass the careers link.`);
  }
  return { family: input.family, name: input.board.trim() };
}

function readBoardsFile(file: string): Record<string, unknown[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SljError('CONFIG_INVALID', `Cannot read boards.json: ${(err as Error).message}`, { file });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SljError('CONFIG_INVALID', 'boards.json must be an object of ATS family → boards.', { file });
  return raw as Record<string, unknown[]>;
}

function entryName(family: AtsFamily, e: unknown): string | null {
  try {
    return parseBoardEntry(family, e).name.toLowerCase();
  } catch {
    return null;
  }
}

const CheckInput = z.object({
  board: z.string().trim().min(1).describe('Board name (a slug, or tenant|wdN|site for Workday) or the careers link'),
  family: z.enum(ATS_FAMILIES).optional().describe('ATS family; not needed when board is a link'),
  company: z.string().trim().min(1).max(200).optional().describe('Employer display name stored with the board'),
  add: z.boolean().default(false).describe('Append the board to config/boards.json if it has Sri Lanka roles right now'),
});

interface CheckResult extends BoardProbe {
  family: AtsFamily;
  board: string;
  added: boolean;
  already_listed: boolean;
  not_added_reason?: string;
}

const boardsCheck = defineCommand({
  name: 'boards.check',
  summary: 'Check an employer ATS board against its API and count its Sri Lanka postings; --add appends it to config/boards.json',
  sideEffect: 'With --add, appends the board to config/boards.json (only when it has Sri Lanka postings now)',
  input: CheckInput,
  positional: 'board',
  async run(input, ctx): Promise<CheckResult> {
    const { family, name } = resolveBoard(input);
    const parsed = parseBoardEntry(family, input.company ? { name, company: input.company } : name);
    const probe = await probeFor(family);
    const client = await httpClient(ctx);
    let result: BoardProbe;
    try {
      result = await probe(client.http, input.company ? { name: parsed.name, company: input.company } : parsed.name);
    } finally {
      await client.close();
    }
    const file = path.join(ctx.paths.configDir, 'boards.json');
    const boards = readBoardsFile(file);
    const list = Array.isArray(boards[family]) ? boards[family] : [];
    const already = list.some((e) => entryName(family, e) === parsed.name.toLowerCase());
    const out: CheckResult = { family, board: parsed.name, ...result, added: false, already_listed: already };
    if (!input.add) return out;
    if (already) out.not_added_reason = 'already in config/boards.json';
    else if (!result.valid) out.not_added_reason = `the board could not be read: ${result.reason ?? 'unknown error'}`;
    else if (result.sri_lanka_postings <= 0) out.not_added_reason = 'it has no Sri Lanka postings right now; a board is added only while it advertises Sri Lanka roles';
    else {
      const company = input.company ?? result.company;
      list.push(company ? { name: parsed.name, company } : parsed.name);
      boards[family] = list;
      fs.writeFileSync(file, `${JSON.stringify(boards, null, 2)}\n`);
      out.added = true;
    }
    return out;
  },
  format(d: CheckResult) {
    const lines = [
      `${d.family} board ${d.board}${d.company ? ` (${d.company})` : ''}: ${d.valid ? 'valid' : `NOT valid${d.reason ? ` (${d.reason})` : ''}`}`,
    ];
    if (d.valid) {
      lines.push(`  ${d.sri_lanka_postings} Sri Lanka posting(s) of ${d.total_postings ?? '?'} open`);
      for (const t of d.sample_titles) lines.push(`  - ${t}`);
    }
    if (d.added) lines.push('  Added to config/boards.json.');
    else if (d.not_added_reason) lines.push(`  Not added: ${d.not_added_reason}.`);
    else if (d.already_listed) lines.push('  Already in config/boards.json.');
    return lines.join('\n');
  },
});

export const boardsCommands: Command[] = [boardsCheck as unknown as Command];
