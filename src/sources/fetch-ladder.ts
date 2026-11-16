/**
 * fetch-ladder.ts — the fallback ladder for one source (PRD §7.3, plan §3.2).
 *
 * `page(url)` tries the source's tiers in order and moves down on a failure or a
 * detected block:
 *   T0/T1  plain HTTP through http.ts. One request covers both: the result is
 *          labelled T0 when the page carries schema.org JobPosting JSON-LD (or is
 *          XML/JSON) and T0 is allowed, otherwise T1.
 *   T2/T3  Chrome through browser.ts. One browser attempt covers both: headless
 *          first (T2), and on a human check the visible window and the person (T3).
 *          T2 without T3 never opens a window; T3 without T2 starts visible.
 *   T5     the last good cached copy, marked stale with its age.
 * T4 and T6 are the agent's job (modes/scan.md) and are skipped here.
 *
 * A fresh cached copy (listing 6 h, detail 24 h) is returned before any tier
 * unless `noCache` is set. A 404 or 410 is an answer and ends the ladder.
 * Once a host was blocked on plain HTTP and needed the browser in this run, its
 * later pages go straight to the browser. Browser calls are serialised: one page
 * at a time, whatever the adapter's concurrency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SljError } from '../errors.ts';
import { BrowserFetcher, detectChallengeInHtml, type FetchCallOptions, type FetchResult } from './browser.ts';
import { createPageCache } from './cache.ts';
import type { BlockReason, HttpClient, Ladder, PageRequest, PageResult, SourceConfig, Tier } from './types.ts';

/** What the ladder needs from a browser. The default wraps BrowserFetcher; tests inject a fake. */
export interface BrowserLike {
  /** Throws SljError('BROWSER_UNAVAILABLE') when no browser can be started. */
  fetch(url: string, opts: FetchCallOptions): Promise<FetchResult>;
  close(): Promise<void>;
}

export interface LadderOptions {
  source: SourceConfig;
  http: HttpClient;
  /** user/cache; pages are stored under <cacheDir>/<source.id>/. */
  cacheDir: string;
  /** user/; holds browser-profile/ and browser-status.json. */
  userDir: string;
  now: () => Date;
  log: (m: string) => void;
  browser?: BrowserLike;
  /** settings.scan.listing_cache_hours / detail_cache_hours. Defaults 6 and 24. */
  listingTtlHours?: number;
  detailTtlHours?: number;
  /** Gap before the browser loads a page plain HTTP just tried on the same host. Default source.delay_ms. */
  sleep?: (ms: number) => Promise<void>;
}

/** Pages bigger than this that the adapter's `expect` rejects are real pages whose selectors drifted. */
export const DRIFT_MIN_BYTES = 20 * 1024;

const LOGIN_PATH = /\/(log-?in|sign-?in|signin|auth|account\/login|users\/sign_in)(\/|\?|$)/i;
const TIER_ORDER: Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
const rank = (t: Tier) => TIER_ORDER.indexOf(t);

/**
 * Is this response a block? HTTP 400+ (403/429/503 are the usual bot answers), a
 * human-check page (the same detector browser.ts runs in the page), or a redirect
 * to a sign-in page. Pass `url` so a page that is itself a sign-in page is not
 * read as a redirect to one.
 */
export function detectBlock(res: { status: number | null; html: string; finalUrl: string; url?: string }): { reason: BlockReason; detail: string } | null {
  const challenge = res.html ? detectChallengeInHtml(res.html) : null;
  if (challenge) return { reason: 'challenge', detail: `human check (${challenge})` };
  try {
    const finalPath = new URL(res.finalUrl).pathname;
    const startPath = res.url ? new URL(res.url).pathname : '';
    if (LOGIN_PATH.test(finalPath) && !LOGIN_PATH.test(startPath)) {
      return { reason: 'login', detail: `redirected to a sign-in page (${finalPath}); slj never signs in` };
    }
  } catch {
    // an unparsable URL is not a block signal
  }
  if (res.status !== null && res.status >= 400) return { reason: 'http', detail: `HTTP ${res.status}` };
  return null;
}

/** Every <script type="application/ld+json"> block that parses, arrays and @graph flattened. */
export function parseJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim().replace(/^<!--|-->$/g, '').replace(/^\s*\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>\s*$/g, '').trim();
    try {
      const data: unknown = JSON.parse(raw);
      for (const item of Array.isArray(data) ? data : [data]) {
        const graph = item && typeof item === 'object' ? (item as Record<string, unknown>)['@graph'] : undefined;
        if (Array.isArray(graph)) out.push(...graph);
        else if (item) out.push(item);
      }
    } catch {
      // A broken block on someone else's site is not our error.
    }
  }
  return out;
}

function hasJobPosting(jsonLd: unknown[]): boolean {
  return jsonLd.some((item) => {
    const t = item && typeof item === 'object' ? (item as Record<string, unknown>)['@type'] : undefined;
    return t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
  });
}

/** The default browser: one BrowserFetcher, started on first use. */
export function defaultBrowser(opts: { userDir: string; source: SourceConfig; log: (m: string) => void }): BrowserLike {
  let fetcher: BrowserFetcher | null = null;
  return {
    fetch(url, call) {
      fetcher ??= new BrowserFetcher({
        profileDir: path.join(opts.userDir, 'browser-profile'),
        statusFile: path.join(opts.userDir, 'browser-status.json'),
        minDelayMs: Math.max(2000, opts.source.delay_ms),
        maxDelayMs: Math.max(5000, opts.source.delay_ms + 3000),
        log: opts.log,
      });
      return fetcher.fetchOne(url, call);
    },
    async close() {
      if (!fetcher) return;
      await fetcher.close();
      fetcher = null;
      // Like BrowserFetcher.fetchAll: once the run is over, nobody is waiting on a check any more.
      try {
        fs.writeFileSync(path.join(opts.userDir, 'browser-status.json'), JSON.stringify({ state: 'idle', at: new Date().toISOString() }, null, 2));
      } catch {
        // a convenience file; never fail a scan over it
      }
    },
  };
}

type Attempt = { ok: true; result: PageResult } | { ok: false; result: PageResult; final?: boolean; blockedByHttp?: boolean };

export function createLadder(opts: LadderOptions): Ladder & { close(): Promise<void> } {
  const { source, http, log } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = createPageCache({
    cacheDir: opts.cacheDir, source: source.id, now: opts.now,
    listingTtlHours: opts.listingTtlHours, detailTtlHours: opts.detailTtlHours,
  });
  const browser = opts.browser ?? defaultBrowser({ userDir: opts.userDir, source, log });
  const tiers = new Set(source.tiers);
  const httpTier = tiers.has('T0') || tiers.has('T1');
  const browserTier = tiers.has('T2') || tiers.has('T3');
  const browserHosts = new Set<string>();
  let browserDown: string | null = null;
  let worst: Tier | null = null;
  let browserQueue: Promise<unknown> = Promise.resolve();

  const note = (t: Tier) => {
    if (worst === null || rank(t) > rank(worst)) worst = t;
  };
  const fail = (url: string, tier: Tier, status: number | null, finalUrl: string, block: { reason: BlockReason; detail: string }): PageResult =>
    ({ ok: false, url, finalUrl, status, html: '', jsonLd: [], tier, block });

  function judge(url: string, req: PageRequest, status: number | null, html: string, finalUrl: string): { reason: BlockReason; detail: string } | null {
    const block = detectBlock({ status, html, finalUrl, url });
    if (block) return block;
    if (req.expect && !req.expect(html)) {
      const kb = Math.round(Buffer.byteLength(html) / 1024);
      return {
        reason: 'drift',
        detail: Buffer.byteLength(html) >= DRIFT_MIN_BYTES
          ? `a ${kb} KB page did not match what the adapter expects (selector drift?)`
          : `a small (${kb} KB) page did not match what the adapter expects (soft block?)`,
      };
    }
    return null;
  }

  async function viaHttp(url: string, req: PageRequest): Promise<Attempt> {
    const label: Tier = tiers.has('T1') ? 'T1' : 'T0';
    let res;
    try {
      res = await http.get(url, { delayMs: source.delay_ms });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, result: fail(url, label, null, url, { reason: 'error', detail }) };
    }
    const finalUrl = res.url || url;
    const block = judge(url, req, res.status, res.text, finalUrl);
    if (block) {
      const final = res.status === 404 || res.status === 410;
      return { ok: false, final, blockedByHttp: !final, result: fail(url, label, res.status, finalUrl, block) };
    }
    const jsonLd = parseJsonLd(res.text);
    const structured = hasJobPosting(jsonLd) || /xml|json/i.test(res.headers['content-type'] ?? '');
    const tier: Tier = tiers.has('T0') && (structured || !tiers.has('T1')) ? 'T0' : 'T1';
    return { ok: true, result: { ok: true, url, finalUrl, status: res.status, html: res.text, jsonLd, tier } };
  }

  async function viaBrowser(url: string, req: PageRequest): Promise<Attempt> {
    const label: Tier = tiers.has('T2') ? 'T2' : 'T3';
    if (browserDown) return { ok: false, result: fail(url, label, null, url, { reason: 'error', detail: browserDown }) };
    const call: FetchCallOptions = {
      waitFor: req.waitFor, scroll: req.scroll,
      handoff: tiers.has('T3'), headed: !tiers.has('T2'),
    };
    const run = browserQueue.then(() => browser.fetch(url, call));
    browserQueue = run.catch(() => {});
    let r: FetchResult;
    try {
      r = await run;
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      if (err instanceof SljError && err.code === 'BROWSER_UNAVAILABLE') {
        browserDown = detail;
        log(`${source.id}: no browser for the ${label} tier (${detail}). Skipping browser tiers for this run.`);
      }
      return { ok: false, result: fail(url, label, null, url, { reason: 'error', detail }) };
    }
    const tier: Tier = r.mode === 'headed' || r.humanSolved ? 'T3' : 'T2';
    if (!r.ok || r.blocked) {
      const reason: BlockReason = r.blocked ?? 'error';
      const detail = r.error ?? (r.challenge ? `human check (${r.challenge})` : reason);
      const final = r.status === 404 || r.status === 410;
      return { ok: false, final, result: fail(url, tier, r.status, r.finalUrl, { reason, detail }) };
    }
    const block = judge(url, req, r.status, r.html, r.finalUrl);
    if (block) return { ok: false, result: fail(url, tier, r.status, r.finalUrl, block) };
    const jsonLd = r.jsonLd.length ? r.jsonLd : parseJsonLd(r.html);
    return { ok: true, result: { ok: true, url, finalUrl: r.finalUrl, status: r.status, html: r.html, jsonLd, tier } };
  }

  async function page(url: string, req: PageRequest = {}): Promise<PageResult> {
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      return fail(url, source.tiers[0] ?? 'T1', null, url, { reason: 'error', detail: 'Not a valid URL.' });
    }

    if (!req.noCache) {
      const hit = cache.fresh(url, req.kind ?? 'listing');
      if (hit && (!req.expect || req.expect(hit.html))) {
        note(hit.tier);
        return { ok: true, url, finalUrl: hit.finalUrl, status: hit.status, html: hit.html, jsonLd: parseJsonLd(hit.html), tier: hit.tier };
      }
    }

    let last: PageResult | null = null;
    let triedHttp = false;
    const steps: ('http' | 'browser' | 'cache')[] = [];
    if (httpTier && !(browserTier && browserHosts.has(host))) steps.push('http');
    if (browserTier) steps.push('browser');
    if (tiers.has('T5')) steps.push('cache');

    for (const step of steps) {
      if (step === 'cache') {
        const lg = cache.lastGood(url);
        if (!lg) continue;
        if (last) log(`${source.id}: ${host} serving the last good copy (${Math.round(lg.ageS / 3600)} h old).`);
        note('T5');
        return {
          ok: true, url, finalUrl: lg.page.finalUrl, status: lg.page.status, html: lg.page.html,
          jsonLd: parseJsonLd(lg.page.html), tier: 'T5', staleAgeS: lg.ageS,
        };
      }
      if (step === 'browser' && triedHttp) await sleep(source.delay_ms);
      const attempt = step === 'http' ? await viaHttp(url, req) : await viaBrowser(url, req);
      if (step === 'http') triedHttp = true;
      if (attempt.ok) {
        const r = attempt.result;
        if (step === 'browser' && triedHttp) browserHosts.add(host);
        cache.put({ url, finalUrl: r.finalUrl, status: r.status, html: r.html, tier: r.tier });
        note(r.tier);
        return r;
      }
      last = attempt.result;
      if (step === 'http' && attempt.blockedByHttp && browserTier) browserHosts.add(host);
      if (attempt.final) break;
      const next = steps[steps.indexOf(step) + 1];
      if (next) log(`${source.id}: ${host} ${last.tier} failed (${last.block?.reason}: ${last.block?.detail}); trying ${next === 'cache' ? 'T5' : next === 'browser' ? 'the browser' : next}.`);
    }

    const result = last ?? fail(url, source.tiers[0] ?? 'T1', null, url, { reason: 'error', detail: 'No usable tier for this source.' });
    note(result.tier);
    return result;
  }

  return {
    page,
    worstTier: () => worst ?? source.tiers[0] ?? 'T1',
    close: () => browser.close(),
  };
}
