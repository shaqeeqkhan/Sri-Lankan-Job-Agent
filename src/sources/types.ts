import type { JobFields } from '../jobs/schema.ts';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';
export type BlockReason = 'http' | 'challenge' | 'login' | 'drift' | 'timeout' | 'gave_up' | 'error';

export interface HttpResponse {
  status: number;
  url: string;                       // final URL after redirects
  headers: Record<string, string>;   // lower-cased names
  text: string;
}
export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  delayMs?: number;                  // per-host minimum gap for this call; default from the source config
}
/** The one HTTP door. Resolves for any status the server returns; callers check `.status`.
 *  Rejects with SljError('FETCH_FAILED') only when the network fails after retries. */
export interface HttpClient {
  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  postJson(url: string, body: unknown, opts?: HttpRequestOptions): Promise<HttpResponse>;
}

export interface PageRequest {
  kind?: 'listing' | 'detail';       // picks the cache TTL: listing 6 h, detail 24 h
  waitFor?: string;                  // CSS selector, browser tiers only
  scroll?: number;                   // browser tiers only
  /** Returns false when the page loaded but is not what the adapter expected (selector drift, soft block). */
  expect?: (html: string) => boolean;
  noCache?: boolean;
}
export interface PageResult {
  ok: boolean;
  url: string;
  finalUrl: string;
  status: number | null;
  html: string;                      // '' when !ok
  jsonLd: unknown[];                 // every parsed <script type="application/ld+json"> block
  tier: Tier;                        // the tier that produced this result
  staleAgeS?: number;                // set when served from the T5 last-good cache
  block?: { reason: BlockReason; detail: string };
}
/** Tries the source's tiers in order for one URL. Never throws for a blocked page: returns ok=false. */
export interface Ladder {
  page(url: string, req?: PageRequest): Promise<PageResult>;
  /** The weakest (highest-numbered) tier any page needed so far in this run. */
  worstTier(): Tier;
}

export type ScrapedJob = JobFields & { source_url: string; external_id: string };

export interface SourceConfig {
  id: string;
  name: string;
  kind: 'board' | 'ats' | 'government';
  hosts: string[];
  enabled: boolean;
  slow: boolean;                     // runs only on request (PRD §5.4a step 3)
  tiers: Tier[];
  max_details: number;
  delay_ms: number;
  options: Record<string, unknown>;
}
export interface SourceContext {
  source: SourceConfig;
  http: HttpClient;
  ladder: Ladder;
  now(): Date;
  since: Date | null;                // skip jobs posted before this when the site gives a posted date
  /** True when an earlier scan already stored this external id: skip its detail fetch. */
  seen(externalId: string): boolean;
  log(message: string): void;        // progress line on stderr
  boards: Record<string, unknown[]>; // config/boards.json, keyed by ATS family
  /** Epoch ms (Date.now clock) after which no new detail page is started; what was fetched is kept.
   *  Set by `jobs scan` from settings.scan.source_budget_s. Use `detailBudget()` from util.ts. */
  deadline?: number;
}
/** Why a source stopped fetching details before its candidates ran out, and how many were left
 *  (not marked seen, so the next scan picks them up). `left` is a lower bound when the adapter
 *  stopped reading listing pages early. */
export interface Truncation {
  reason: 'time' | 'max_details';
  left: number;
}
export interface SourceResult {
  jobs: ScrapedJob[];
  listed: number;                    // entries found on listings before any detail fetch
  skippedSeen: number;
  deferred: string[];                // external ids whose detail fetch failed (PRD §7.2 defer_job)
  truncated?: Truncation;
  /** External ids whose detail page WAS read but showed a job not worth storing (expired, closed,
   *  gone, overseas, posted before `since`). Not stored; `jobs scan` marks them seen so they are not
   *  fetched again on every scan. Never put a failed fetch here: that is `deferred`. */
  dropped?: string[];
}
export type Liveness = 'alive' | 'closed' | 'unknown';   // unknown is treated as alive
export interface SourceAdapter {
  id: string;
  scan(ctx: SourceContext): Promise<SourceResult>;
  recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness>;
}
