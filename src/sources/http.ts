/**
 * http.ts — the one HTTP door every source goes through (PRD §7.2, ported from
 * ThreatHire's `job-scraper/utils/http.py`).
 *
 * 1. Connection reuse: one pooled undici Agent per client.
 * 2. Per-host throttle: a request claims its host's next slot synchronously (the
 *    JavaScript equivalent of "under a lock"), then sleeps outside it. Requests to
 *    other hosts never wait on each other. Never pace with a loop-level sleep
 *    (ThreatHire rule 10): pass `delayMs` and the pacing is automatic.
 * 3. Small retries for failures that say nothing about the site:
 *      connect errors ×2, read errors ×1, 502/503/504 ×2, at most 3 in total;
 *      backoff 1 s, 2 s, 4 s (a 1 s floor, so even the first retry is polite).
 *    Never retried: any other 4xx (a 404 is an answer), 429 (the source backs off
 *    itself), other errors. `Retry-After` is honoured on 503 only, capped at 30 s.
 *    Every retry also goes back through the host throttle.
 *
 * Resolves for any status the server returns. Rejects with SljError('FETCH_FAILED')
 * only when the network fails after retries, or the body is over the size cap.
 */
import { Agent, fetch as undiciFetch } from 'undici';
import { SljError } from '../errors.ts';
import type { HttpClient, HttpRequestOptions, HttpResponse } from './types.ts';

export const DEFAULT_USER_AGENT = 'SriLankanJobsAgent/0.2 (+https://srilankanjobs.lk/agent)';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const RETRY_AFTER_CAP_MS = 30_000;

const RETRY_STATUS = new Set([502, 503, 504]);
const BUDGET = { total: 3, connect: 2, read: 1, status: 2 } as const;

const CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const READ_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED', 'UND_ERR_ABORTED',
]);

export type FailureKind = 'connect' | 'read' | 'other';

/** Which retry budget a thrown network error draws on. Unknown errors are not retried. */
export function classifyFailure(err: unknown): FailureKind {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const o = e as { name?: string; code?: string; message?: string; cause?: unknown };
    if (o.name === 'TimeoutError' || o.name === 'AbortError') return 'read';
    if (o.code && CONNECT_CODES.has(o.code)) return 'connect';
    if (o.code && READ_CODES.has(o.code)) return 'read';
    if (typeof o.message === 'string' && /^terminated$|other side closed/i.test(o.message)) return 'read';
    e = o.cause;
  }
  return 'other';
}

/** Retry-After as milliseconds (seconds or an HTTP date), or null. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** urllib3's backoff (factor 1 s) with a 1 s floor: 1 s, 2 s, 4 s … capped at 120 s. */
export function backoffMs(retryNumber: number): number {
  return Math.min(120_000, Math.max(1000, 1000 * 2 ** (retryNumber - 1)));
}

export interface HttpClientOptions {
  /** Used instead of undici when given (tests). */
  fetch?: typeof fetch;
  /** Per-host minimum gap when a call passes no `delayMs`. Default 0 (no pacing). */
  defaultDelayMs?: number;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in ms. Default Date.now. */
  now?: () => number;
  /** Response body cap in bytes. Default 5 MB. */
  maxBytes?: number;
}

export type ClosableHttpClient = HttpClient & {
  /** Closes the pooled connections. Safe to call more than once. */
  close(): Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createHttpClient(opts: HttpClientOptions = {}): ClosableHttpClient {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const nextAllowed = new Map<string, number>();
  let agent: Agent | null = null;

  const doFetch: typeof fetch = opts.fetch
    ?? (((input: string | URL | Request, init?: RequestInit) => {
      // autoSelectFamily: a network that black-holes IPv6 must not stall us (ThreatHire gotcha).
      agent ??= new Agent({ connections: 8, keepAliveTimeout: 10_000, connect: { autoSelectFamily: true } });
      return undiciFetch(input as string, { ...(init as object), dispatcher: agent } as Parameters<typeof undiciFetch>[1]);
    }) as unknown as typeof fetch);

  /** Claim the host's next slot synchronously, then wait for it outside the "lock". */
  async function throttle(host: string, delayMs: number): Promise<void> {
    if (!(delayMs > 0)) return;
    const t = now();
    const earliest = nextAllowed.get(host) ?? 0;
    const startAt = earliest > t ? earliest : t;
    nextAllowed.set(host, startAt + delayMs);
    const wait = startAt - now();
    if (wait > 0) await sleep(wait);
  }

  async function readBody(res: Response, host: string): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new SljError('FETCH_FAILED', `${host} sent a page larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, { reason: 'too_large' });
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SljError('FETCH_FAILED', `${host} sent a page larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, { reason: 'too_large' });
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  async function request(method: 'GET' | 'POST', url: string, body: string | undefined, o: HttpRequestOptions = {}): Promise<HttpResponse> {
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      throw new SljError('INVALID_INPUT', `Not a valid URL: ${url}`);
    }
    const delayMs = o.delayMs ?? opts.defaultDelayMs ?? 0;
    const headers: Record<string, string> = {
      'user-agent': userAgent,
      accept: method === 'POST'
        ? 'application/json'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5',
      'accept-language': 'en-US,en;q=0.8',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v;

    const used = { total: 0, connect: 0, read: 0, status: 0 };
    let retryNumber = 0;
    for (;;) {
      await throttle(host, delayMs);
      let res: Response;
      let text: string;
      try {
        res = await doFetch(url, {
          method, headers, body, redirect: 'follow',
          signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        text = await readBody(res, host);
      } catch (err) {
        if (err instanceof SljError) throw err;
        const kind = classifyFailure(err);
        if (kind !== 'other' && used.total < BUDGET.total && used[kind] < BUDGET[kind]) {
          used.total++;
          used[kind]++;
          await sleep(backoffMs(++retryNumber));
          continue;
        }
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        const msg = cause?.code ?? cause?.message ?? (err as Error).message ?? String(err);
        throw new SljError('FETCH_FAILED', `Could not reach ${host}: ${msg}`, { url, kind, attempts: used.total + 1 });
      }

      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { outHeaders[k.toLowerCase()] = v; });
      const out: HttpResponse = { status: res.status, url: res.url || url, headers: outHeaders, text };

      if (RETRY_STATUS.has(res.status) && used.total < BUDGET.total && used.status < BUDGET.status) {
        used.total++;
        used.status++;
        retryNumber++;
        let wait = backoffMs(retryNumber);
        if (res.status === 503) {
          const ra = parseRetryAfter(outHeaders['retry-after'], Date.now());
          if (ra !== null) wait = Math.max(1000, Math.min(ra, RETRY_AFTER_CAP_MS));
        }
        await sleep(wait);
        continue;
      }
      return out;
    }
  }

  return {
    get: (url, o) => request('GET', url, undefined, o),
    postJson: (url, body, o) => request('POST', url, JSON.stringify(body), o),
    async close() {
      const a = agent;
      agent = null;
      if (a) await a.close().catch(() => {});
    },
  };
}
