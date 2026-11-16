/**
 * `slj jobs scan` and `slj jobs recheck` (PRD §5.2, §7.2; ThreatHire `main.py` `_collect_sources`).
 *
 * - Sources run concurrently (settings.scan.source_workers) and are rejoined in sources.yml order,
 *   so first-copy-wins dedupe gives the same result whatever finishes first.
 * - A failing source never kills the scan: it is PARTIAL (or blocked) and the rest go on. Only when
 *   every source failed is the scan a failure.
 * - A deferred job (failed detail fetch) is not stored and not marked seen, and every cross-source
 *   copy of it is held back too, so a weaker source cannot win it by accident.
 * - Jobs are normalised here: description cleaned, dates and salary parsed only into nulls (rule 9).
 */
import crypto from 'node:crypto';
import os from 'node:os';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { cleanDescription } from '../jobs/clean.ts';
import { extract } from '../jobs/extract.ts';
import { identityKeys } from '../jobs/identity.ts';
import { canonicalUrl, fillNulls, inferApplyMethod, parseDate, parseSalary } from '../jobs/normalize.ts';
import { isForeignJob, parsePlace } from '../jobs/places.ts';
import { JobFields } from '../jobs/schema.ts';
import {
  closeJob, closePassedJobs, colomboToday, countOpenJobs, loadSeen, markSeen, seenHash, storedKeysFor, upsertJob,
  type StoreInput,
} from '../jobs/store.ts';
import { loadDayReport } from '../match/day-report.ts';
import { matchKey, type MatchKey } from '../match/jobs.ts';
import { bumpStat } from '../user/profile.ts';
import { loadAdapter as defaultLoadAdapter, sourceConfigs } from './load.ts';
import { recordScan, type SourceRunStats, type SourceStatus } from './status.ts';
import type {
  HttpClient, Ladder, Liveness, PageRequest, PageResult, ScrapedJob, SourceAdapter, SourceConfig, SourceContext,
  SourceResult, Tier,
} from './types.ts';
import { mapInOrder } from './util.ts';

// ---------------------------------------------------------------- injectable pieces

type Closable = { close?(): Promise<void> };
export type MakeHttp = (opts: { fetch?: typeof fetch; defaultDelayMs: number }) => (HttpClient & Closable) | Promise<HttpClient & Closable>;
export interface LadderFactoryOptions {
  source: SourceConfig;
  http: HttpClient;
  cacheDir: string;
  userDir: string;
  now: () => Date;
  log: (m: string) => void;
  listingTtlHours?: number;
  detailTtlHours?: number;
}
export type MakeLadder = (opts: LadderFactoryOptions) => (Ladder & Closable) | Promise<Ladder & Closable>;

export interface ScanDeps {
  makeHttp?: MakeHttp;
  makeLadder?: MakeLadder;
  loadAdapter?: (id: string) => Promise<SourceAdapter>;
  /** Progress lines. Default: stderr. */
  log?: (m: string) => void;
}

// S1's modules are imported lazily, so this file (and its tests) never depend on them existing.
const defaultMakeHttp: MakeHttp = async (opts) => {
  const mod = (await import('./http.ts')) as { createHttpClient: (o: { fetch?: typeof fetch; defaultDelayMs?: number }) => HttpClient & Closable };
  return mod.createHttpClient(opts);
};
const defaultMakeLadder: MakeLadder = async (opts) => {
  const mod = (await import('./fetch-ladder.ts' as string)) as { createLadder: (o: LadderFactoryOptions) => Ladder & Closable };
  return mod.createLadder(opts);
};
const stderrLog = (m: string) => void process.stderr.write(`${m}\n`);

/** The fetch the HTTP door should use: none (its pooled undici agent) unless a test injected one. */
function injectedFetch(ctx: Context): typeof fetch | undefined {
  return ctx.fetch === globalThis.fetch ? undefined : ctx.fetch;
}

function ladderOptions(ctx: Context, source: SourceConfig, http: HttpClient, log: (m: string) => void): LadderFactoryOptions {
  const scan = ctx.config().settings.scan;
  return {
    source, http, cacheDir: ctx.paths.cacheDir, userDir: ctx.paths.userDir, now: () => ctx.now(), log,
    listingTtlHours: scan.listing_cache_hours, detailTtlHours: scan.detail_cache_hours,
  };
}

// ---------------------------------------------------------------- report shape

export interface ScanSourceReport {
  id: string;
  name: string;
  status: SourceStatus;
  failed: boolean;
  /** Weakest tier a page needed (or the source's first tier for API-only sources); null when nothing loaded. */
  tier: Tier | null;
  listed: number;
  /** Jobs the adapter returned. */
  found: number;
  inserted: number;
  merged: number;
  unchanged: number;
  skipped_seen: number;
  deferred: number;
  /** Copies of a deferred job (from this or another source) not stored this scan. */
  held_back: number;
  /** Already past their closing date, or posted before --since. */
  skipped_closed: number;
  skipped_old: number;
  /** Overseas jobs (PRD §4): a non-LK country code or a clearly foreign location. Not stored. */
  skipped_foreign: number;
  /** The source stopped fetching details early (time budget or max_details); `left` wait for the next scan. */
  truncated: boolean;
  truncated_reason: 'time' | 'max_details' | null;
  truncated_left: number;
  /** Detail pages read that showed a closed, gone, overseas or too-old job: not stored, marked seen. */
  dropped: number;
  /** Rows that failed validation (e.g. no title). */
  invalid: number;
  pages: { ok: number; blocked: number; stale: number };
  stale_age_s: number | null;
  duration_s: number;
  error: string | null;
  low: boolean;
}

export type ScanSelection = 'normal' | 'slow' | 'all' | 'named';

export interface ScanReport {
  scan_id: string;
  started_at: string;
  finished_at: string;
  duration_s: number;
  since: string | null;
  sources: ScanSourceReport[];
  /** Which sources this scan picked: the normal (fast) ones, only the slow ones (--slow), both (--all), or named (--sources). */
  selection: ScanSelection;
  /** Sources not run, and why: slow ones in a normal scan, fast ones in a --slow scan, disabled ones. */
  not_run: { id: string; reason: 'slow' | 'fast' | 'disabled' }[];
  totals: { listed: number; found: number; inserted: number; merged: number; deferred: number; held_back: number; skipped_foreign: number };
  failed_sources: string[];
  low_sources: string[];
  all_failed: boolean;
  closed_now: number;
  open_jobs: number;
}

// ---------------------------------------------------------------- helpers

const TIER_ORDER: Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
const tierIdx = (t: Tier) => TIER_ORDER.indexOf(t);

/** The tier a source normally works at: T0 plus its next tier when it starts with T0, else its first. */
function normalTier(tiers: Tier[]): Tier {
  if (!tiers.length) return 'T1';
  return tiers[0] === 'T0' && tiers[1] && tiers[1] !== 'T5' ? tiers[1] : tiers[0];
}

function scrub(message: string, ctx: Context): string {
  let m = message;
  for (const p of [ctx.paths.userDir, os.homedir()]) if (p) m = m.split(p).join('~');
  return m.slice(0, 300);
}

/** Wraps a ladder so the scan can see every page result (blocks, tiers, stale cache). */
function recordingLadder(inner: Ladder): Ladder & { results: PageResult[] } {
  const results: PageResult[] = [];
  return {
    results,
    async page(url: string, req?: PageRequest) {
      const r = await inner.page(url, req);
      results.push(r);
      return r;
    },
    worstTier: () => inner.worstTier(),
  };
}

/** Per-source http: calls without a delay get the source's delay_ms (pacing per host, never a loop sleep). */
function pacedHttp(http: HttpClient, delayMs: number): HttpClient {
  return {
    get: (url, opts) => http.get(url, { ...opts, delayMs: opts?.delayMs ?? delayMs }),
    postJson: (url, body, opts) => http.postJson(url, body, { ...opts, delayMs: opts?.delayMs ?? delayMs }),
  };
}

function statusFor(source: SourceConfig, threw: boolean, result: SourceResult | null, pages: PageResult[]) {
  const ok = pages.filter((p) => p.ok);
  const bad = pages.filter((p) => !p.ok);
  const stale = ok.filter((p) => p.tier === 'T5' || p.staleAgeS != null);
  const fresh = ok.filter((p) => !(p.tier === 'T5' || p.staleAgeS != null));
  let tier: Tier | null = null;
  for (const p of ok) if (!tier || tierIdx(p.tier) > tierIdx(tier)) tier = p.tier;
  if (!tier && !threw) tier = source.tiers[0] ?? null;
  let status: SourceStatus;
  if (threw) status = pages.length > 0 && ok.length === 0 ? 'blocked' : 'partial';
  else if ((result?.listed ?? 0) === 0 && bad.length > 0 && ok.length === 0) status = 'blocked';
  else if (stale.length > 0) status = 'stale-cache';
  else {
    const worst = fresh.reduce<Tier | null>((w, p) => (!w || tierIdx(p.tier) > tierIdx(w) ? p.tier : w), null);
    status = worst && tierIdx(worst) > tierIdx(normalTier(source.tiers)) ? `degraded:${worst}` : 'ok';
  }
  return {
    status,
    failed: status === 'partial' || status === 'blocked',
    tier,
    http_status: [...bad].reverse().find((p) => p.status != null)?.status ?? null,
    // A check that was shown and then completed leaves only an ok T3 page: it still counts as a challenge.
    // (With T2 in the ladder, T3 is reached only after the headless browser met a human check.)
    challenge: pages.some((p) => p.block?.reason === 'challenge') || (source.tiers.includes('T2') && ok.some((p) => p.tier === 'T3')),
    human_solved: ok.some((p) => p.tier === 'T3'),
    stale_age_s: stale.length ? Math.max(...stale.map((p) => p.staleAgeS ?? 0)) : null,
    pages: { ok: fresh.length, blocked: bad.length, stale: stale.length },
  };
}

/** Days from "14d", "30", "2w". */
export function parseSinceDays(raw: string | number | undefined | null): number | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'number') return raw;
  const m = raw.trim().match(/^(\d+)\s*(d|days?|w|weeks?)?$/i);
  if (!m) throw new SljError('INVALID_INPUT', `--since takes a number of days such as 14d or 30, not "${raw}".`);
  const n = Number(m[1]) * (/^w/i.test(m[2] ?? '') ? 7 : 1);
  if (n < 1 || n > 365) throw new SljError('INVALID_INPUT', '--since must be between 1 and 365 days.');
  return n;
}

const FIELD_NAMES = Object.keys(JobFields.shape) as (keyof JobFields)[];

/**
 * A scraped job → store input. Structured values win; text parsers only fill nulls (rule 9), and
 * anything that would not validate is dropped rather than guessed (rule 11). null when unusable.
 */
export function prepareScrapedJob(job: ScrapedJob, source: SourceConfig, now: Date): StoreInput | null {
  const raw = job as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const k of FIELD_NAMES) {
    let v = raw[k];
    if (v == null || v === '') continue;
    if (k === 'description') v = cleanDescription(String(v)) || null;
    if (k === 'closing_date' && typeof v === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = parseDate(v, { now });
    if (k === 'closing_date' && typeof v === 'string') v = v.slice(0, 10);
    if (v == null) continue;
    if (JobFields.shape[k].safeParse(v).success) fields[k] = v;
  }
  if (!fields.title) return null;
  const desc = (fields.description as string | undefined) ?? '';
  const parsed: Partial<JobFields> = {};
  if (desc) {
    const ex = extract({ text: desc });
    for (const k of ['closing_date', 'apply_email', 'subject_instruction', 'required_docs'] as const) {
      const v = ex.fields[k];
      if (v != null && JobFields.shape[k].safeParse(v).success) (parsed as Record<string, unknown>)[k] = v;
    }
    const sal = parseSalary(desc);
    if (sal) parsed.salary_text = sal.text;
  }
  const place = parsePlace(fields.location as string | undefined);
  if (place.district) parsed.country_code = 'LK';
  if (place.remote) parsed.remote = true;
  parsed.scraped_at = now.toISOString();
  parsed.external_id = job.external_id;
  const merged = fillNulls(fields as Partial<JobFields>, parsed) as JobFields;
  const portal = ['board', 'ats', 'government'].includes(source.kind);
  return { ...merged, platform: source.id, apply_method: inferApplyMethod(merged, portal) } as StoreInput;
}

// ---------------------------------------------------------------- scan

interface SourceOutcome {
  source: SourceConfig;
  result: SourceResult | null;
  error: string | null;
  pages: PageResult[];
  duration_s: number;
}

export interface ScanOptions {
  /** Named sources: run exactly these (even slow or disabled ones), in sources.yml order. */
  sources?: string[];
  sinceDays?: number;
  /** Only the slow sources (PRD §5.4a widening step, run after a normal scan). */
  slowOnly?: boolean;
  /** Fast and slow sources together. */
  includeSlow?: boolean;
}

export async function runScan(
  ctx: Context,
  opts: ScanOptions,
  deps: ScanDeps = {},
): Promise<ScanReport> {
  const log = deps.log ?? stderrLog;
  const config = ctx.config();
  const all = sourceConfigs(config);
  const precedence = all.map((s) => s.id);
  const startedAt = ctx.now();
  const scanId = `${startedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;

  let selected: SourceConfig[];
  const notRun: ScanReport['not_run'] = [];
  const selection: ScanSelection = opts.sources?.length ? 'named' : opts.includeSlow ? 'all' : opts.slowOnly ? 'slow' : 'normal';
  if (opts.sources?.length) {
    const unknown = opts.sources.filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) {
      throw new SljError('INVALID_INPUT', `Unknown source(s): ${unknown.join(', ')}. Known: ${precedence.join(', ')}`);
    }
    // Named sources run even when slow or disabled: the person asked for them. Kept in list order.
    selected = all.filter((s) => opts.sources!.includes(s.id));
  } else {
    selected = [];
    for (const s of all) {
      if (!s.enabled) notRun.push({ id: s.id, reason: 'disabled' });
      else if (s.slow && selection === 'normal') notRun.push({ id: s.id, reason: 'slow' });
      else if (!s.slow && selection === 'slow') notRun.push({ id: s.id, reason: 'fast' });
      else selected.push(s);
    }
  }

  const sinceDays = opts.sinceDays ?? config.settings.scan.since_days;
  const since = new Date(startedAt.getTime() - sinceDays * 86_400_000);
  const db = ctx.db();
  const loadAdapter = deps.loadAdapter ?? defaultLoadAdapter;
  const makeLadder = deps.makeLadder ?? defaultMakeLadder;

  const budgetMs = config.settings.scan.source_budget_s * 1000;
  if (selection === 'slow' && !selected.length) log('[scan] no slow sources are enabled in config/sources.yml');
  log(`[scan] ${selected.length} source(s), up to ${config.settings.scan.source_workers} at a time, since ${since.toISOString().slice(0, 10)}${budgetMs ? `, ${config.settings.scan.source_budget_s}s per source` : ''}`);
  let http: (HttpClient & Closable) | null = null;
  let httpError: string | null = null;
  if (selected.length) {
    try {
      http = await (deps.makeHttp ?? defaultMakeHttp)({ fetch: injectedFetch(ctx), defaultDelayMs: config.settings.scan.html_delay_ms });
    } catch (err) {
      httpError = `HTTP client unavailable: ${(err as Error).message}`;
    }
  }

  let outcomes: SourceOutcome[];
  try {
    outcomes = await mapInOrder(
      selected,
      async (source): Promise<SourceOutcome> => {
        const t0 = Date.now();
        const slog = (m: string) => log(`[${source.id}] ${m}`);
        let ladder: (Ladder & Closable) | null = null;
        let recorder: ReturnType<typeof recordingLadder> | null = null;
        try {
          if (!http) throw new Error(httpError ?? 'HTTP client unavailable');
          const adapter = await loadAdapter(source.id);
          const shttp = pacedHttp(http, source.delay_ms);
          ladder = await makeLadder(ladderOptions(ctx, source, shttp, slog));
          recorder = recordingLadder(ladder);
          const seen = loadSeen(db, source.id);
          const sctx: SourceContext = {
            source,
            http: shttp,
            ladder: recorder,
            now: () => ctx.now(),
            since,
            seen: (id) => seen.has(seenHash(id)),
            log: slog,
            boards: config.boards as unknown as Record<string, unknown[]>,
            // The budget starts when the source does (it may have waited for a worker).
            deadline: budgetMs > 0 ? Date.now() + budgetMs : undefined,
          };
          const result = await adapter.scan(sctx);
          const out = { source, result, error: null, pages: recorder.results, duration_s: (Date.now() - t0) / 1000 };
          slog(`${result.listed} listed, ${result.jobs.length} new or changed, ${result.skippedSeen} seen, ${result.deferred.length} deferred${result.truncated ? `, stopped early (${result.truncated.reason}), ${result.truncated.left} left for next scan` : ""} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
          return out;
        } catch (err) {
          const msg = scrub(err instanceof Error ? err.message : String(err), ctx);
          slog(`PARTIAL: source failed after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${msg}`);
          return { source, result: null, error: msg, pages: recorder?.results ?? [], duration_s: (Date.now() - t0) / 1000 };
        } finally {
          await ladder?.close?.().catch(() => {});
        }
      },
      config.settings.scan.source_workers,
    );
  } finally {
    await http?.close?.().catch(() => {});
  }

  // Every key a deferred job is known by, from every source, before anything is stored.
  const held = new Set<string>();
  for (const o of outcomes) {
    const ids = o.result?.deferred ?? [];
    for (const id of ids) held.add(`${o.source.id}|${id}`);
    for (const k of storedKeysFor(db, o.source.id, ids)) held.add(k);
  }

  const now = ctx.now();
  const today = colomboToday(now);
  const reports: ScanSourceReport[] = [];
  const statuses = new Map<string, ReturnType<typeof statusFor>>();
  db.transaction(() => {
    for (const o of outcomes) {
      const st = statusFor(o.source, o.error != null, o.result, o.pages);
      statuses.set(o.source.id, st);
      const r: ScanSourceReport = {
        id: o.source.id,
        name: o.source.name,
        status: st.status,
        failed: st.failed,
        tier: st.tier,
        listed: o.result?.listed ?? 0,
        found: o.result?.jobs.length ?? 0,
        inserted: 0,
        merged: 0,
        unchanged: 0,
        skipped_seen: o.result?.skippedSeen ?? 0,
        deferred: o.result?.deferred.length ?? 0,
        held_back: 0,
        skipped_closed: 0,
        skipped_old: 0,
        skipped_foreign: 0,
        truncated: !!o.result?.truncated,
        truncated_reason: o.result?.truncated?.reason ?? null,
        truncated_left: o.result?.truncated?.left ?? 0,
        dropped: 0,
        invalid: 0,
        pages: st.pages,
        stale_age_s: st.stale_age_s,
        duration_s: Math.round(o.duration_s * 10) / 10,
        error: o.error,
        low: false,
      };
      const deferredHere = new Set(o.result?.deferred ?? []);
      // Read and found not worth storing (closed, gone, overseas, too old): seen, so not fetched again.
      for (const id of new Set(o.result?.dropped ?? [])) {
        if (!id || deferredHere.has(id)) continue;
        r.dropped++;
        markSeen(db, o.source.id, id, now);
      }
      for (const job of o.result?.jobs ?? []) {
        if (!job?.external_id || deferredHere.has(job.external_id)) {
          r.invalid += job?.external_id ? 0 : 1;
          continue;
        }
        const input = prepareScrapedJob(job, o.source, now);
        if (!input) {
          r.invalid++;
          continue;
        }
        const keys = identityKeys(input);
        if ([keys.tier1, keys.tier1b, keys.tier2, `${o.source.id}|${job.external_id}`].some((k) => k && held.has(k))) {
          r.held_back++;
          continue;
        }
        if (isForeignJob(input)) {
          // Marked seen, so an overseas posting is not fetched again every scan.
          r.skipped_foreign++;
          markSeen(db, o.source.id, job.external_id, now);
          continue;
        }
        if (input.closing_date && input.closing_date < today) {
          r.skipped_closed++;
          markSeen(db, o.source.id, job.external_id, now);
          continue;
        }
        const posted = input.posted_at ? parseDate(input.posted_at) : null;
        if (posted && posted < since.toISOString().slice(0, 10)) {
          r.skipped_old++;
          markSeen(db, o.source.id, job.external_id, now);
          continue;
        }
        const res = upsertJob(
          db,
          input,
          { source: o.source.id, source_ref: job.external_id, source_url: canonicalUrl(job.source_url) ?? job.source_url },
          now,
          { precedence },
        );
        r[res.outcome]++;
        markSeen(db, o.source.id, job.external_id, now);
      }
      reports.push(r);
    }
  })();

  const closedNow = closePassedJobs(db, now);
  const finishedAt = ctx.now();
  const stats: Record<string, SourceRunStats> = {};
  for (const r of reports) {
    stats[r.id] = {
      status: r.status,
      failed: r.failed,
      error: r.error,
      tier: r.tier,
      listed: r.listed,
      jobs: r.found,
      deferred: r.deferred,
      http_status: statuses.get(r.id)!.http_status,
      challenge: statuses.get(r.id)!.challenge,
      human_solved: statuses.get(r.id)!.human_solved,
      stale_age_s: r.stale_age_s,
      duration_s: r.duration_s,
      truncated: r.truncated,
      truncated_reason: r.truncated_reason,
      truncated_left: r.truncated_left,
      finished_at: finishedAt.toISOString(),
    };
  }
  const failed = reports.filter((r) => r.failed).map((r) => r.id);
  const allFailed = reports.length > 0 && failed.length === reports.length;
  let low: string[] = [];
  if (reports.length) {
    low = recordScan(
      ctx,
      {
        scan_id: scanId,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        result: allFailed ? 'failed' : failed.length ? 'partial' : 'ok',
        sources: stats,
      },
      log,
    ).low_sources;
    for (const r of reports) r.low = low.includes(r.id);
  }
  try {
    bumpStat(ctx, 'scans');
  } catch {
    // Counters are informational only.
  }

  const sum = (k: keyof ScanReport['totals']) => reports.reduce((n, r) => n + r[k], 0);
  const report: ScanReport = {
    scan_id: scanId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_s: Math.round((finishedAt.getTime() - startedAt.getTime()) / 100) / 10,
    since: since.toISOString(),
    sources: reports,
    selection,
    not_run: notRun,
    totals: { listed: sum('listed'), found: sum('found'), inserted: sum('inserted'), merged: sum('merged'), deferred: sum('deferred'), held_back: sum('held_back'), skipped_foreign: sum('skipped_foreign') },
    failed_sources: failed,
    low_sources: low,
    all_failed: allFailed,
    closed_now: closedNow,
    open_jobs: countOpenJobs(db, now),
  };
  if (failed.length && !allFailed) log(`[scan] PARTIAL: ${failed.length} source(s) failed and were skipped: ${failed.join(', ')}. The other sources' jobs are kept.`);
  if (low.length) log(`[scan] Unusually low intake from: ${low.join(', ')} (treat as broken, not a quiet day)`);
  log(`[scan] done: ${report.totals.inserted} new, ${report.totals.merged} merged, ${report.open_jobs} open jobs`);
  return report;
}

// ---------------------------------------------------------------- recheck

export interface RecheckRow {
  id: string;
  title: string;
  liveness: Liveness;
  closed: boolean;
  reason: string;
  checked: { source: string; liveness: Liveness; error?: string }[];
}

/**
 * The job ids being shown: today's top report (Colombo date) for the current resume, read from
 * `top_reports` the way `slj top` writes it (src/match/day-report.ts). The latest page shown
 * ("#21-#40" after "more jobs"), in report order; with no page recorded, the first top_n numbers.
 * Empty when there is no resume or no report today.
 */
export function latestTopJobIds(ctx: Context): string[] {
  let key: MatchKey;
  try {
    key = matchKey(ctx);
  } catch {
    return []; // no resume.md: no report can exist for it
  }
  const report = loadDayReport(ctx.db(), key);
  if (!report.numbered.length) return [];
  const page = report.pages.at(-1);
  const numbers = page?.numbers.length ? page.numbers : report.numbered.slice(0, ctx.config().settings.top_n).map((_, i) => i + 1);
  return numbers.map((n) => report.numbered[n - 1]).filter((id): id is string => !!id);
}

/**
 * Liveness check for a few jobs (the ones about to be shown). Ambiguous means alive (ThreatHire
 * rule 2): a job is closed only when its closing date has passed, or when every source adapter that
 * can check it says `closed`. Errors and `unknown` keep it open.
 */
export async function runRecheck(ctx: Context, ids: string[], deps: ScanDeps = {}): Promise<{ rows: RecheckRow[]; closed: number; checked: number }> {
  const log = deps.log ?? stderrLog;
  const db = ctx.db();
  const config = ctx.config();
  const configs = new Map(sourceConfigs(config).map((s) => [s.id, s]));
  const now = ctx.now();
  const today = colomboToday(now);
  const loadAdapter = deps.loadAdapter ?? defaultLoadAdapter;
  let http: (HttpClient & Closable) | null = null;
  const ladders = new Map<string, Ladder & Closable>();
  const rows: RecheckRow[] = [];

  try {
    for (const id of ids) {
      const job = db.prepare('SELECT id, title, closing_date, closed_at, closed_reason FROM jobs WHERE id = ?').get(id) as
        | { id: string; title: string; closing_date: string | null; closed_at: string | null; closed_reason: string | null }
        | undefined;
      if (!job) {
        rows.push({ id, title: '', liveness: 'unknown', closed: false, reason: 'no such job', checked: [] });
        continue;
      }
      if (job.closed_at) {
        rows.push({ id, title: job.title, liveness: 'closed', closed: true, reason: job.closed_reason ?? 'closed', checked: [] });
        continue;
      }
      if (job.closing_date && job.closing_date < today) {
        closeJob(db, id, 'closing_date_passed', now);
        rows.push({ id, title: job.title, liveness: 'closed', closed: true, reason: `closing date ${job.closing_date} has passed`, checked: [] });
        continue;
      }
      const srcs = db.prepare('SELECT source, source_ref, source_url FROM job_sources WHERE job_id = ?').all(id) as {
        source: string;
        source_ref: string;
        source_url: string | null;
      }[];
      const checked: RecheckRow['checked'] = [];
      for (const s of srcs) {
        const cfg = configs.get(s.source);
        if (!cfg || !s.source_url) continue;
        try {
          const adapter = await loadAdapter(cfg.id);
          http ??= await (deps.makeHttp ?? defaultMakeHttp)({ fetch: injectedFetch(ctx), defaultDelayMs: config.settings.scan.html_delay_ms });
          const shttp = pacedHttp(http, cfg.delay_ms);
          let ladder = ladders.get(cfg.id);
          if (!ladder) {
            ladder = await (deps.makeLadder ?? defaultMakeLadder)(ladderOptions(ctx, cfg, shttp, (m) => log(`[${cfg.id}] ${m}`)));
            ladders.set(cfg.id, ladder);
          }
          const sctx: SourceContext = {
            source: cfg, http: shttp, ladder, now: () => ctx.now(), since: null, seen: () => false,
            log: (m) => log(`[${cfg.id}] ${m}`), boards: config.boards as unknown as Record<string, unknown[]>,
          };
          const l = await adapter.recheck({ source_url: s.source_url, external_id: s.source_ref }, sctx);
          checked.push({ source: s.source, liveness: l === 'closed' || l === 'alive' ? l : 'unknown' });
        } catch (err) {
          checked.push({ source: s.source, liveness: 'unknown', error: scrub((err as Error).message ?? String(err), ctx) });
        }
      }
      const allClosed = checked.length > 0 && checked.every((c) => c.liveness === 'closed');
      if (allClosed) closeJob(db, id, `${checked.map((c) => c.source).join('+')}:closed`, now);
      const liveness: Liveness = allClosed ? 'closed' : checked.some((c) => c.liveness === 'alive') ? 'alive' : 'unknown';
      rows.push({
        id,
        title: job.title,
        liveness,
        closed: allClosed,
        reason: allClosed ? 'the site says the posting is closed' : checked.length ? 'not clearly closed, kept' : 'no source can check it; kept',
        checked,
      });
    }
  } finally {
    for (const l of ladders.values()) await l.close?.().catch(() => {});
    await http?.close?.().catch(() => {});
  }
  return { rows, closed: rows.filter((r) => r.closed).length, checked: rows.length };
}
