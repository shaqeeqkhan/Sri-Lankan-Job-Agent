import fs from 'node:fs';
import path from 'node:path';
import MiniSearch from 'minisearch';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { bumpStat } from '../user/profile.ts';
import { jobRef, loadDayReport, parseNumber, resolveNumber, saveDayReport, type DayReport } from './day-report.ts';
import { placeOf } from './deps.ts';
import { isOpen, jobsById, matchKey, openJobs, type MatchJob, type MatchKey } from './jobs.ts';
import { buildPool, type PoolOptions } from './prefilter.ts';
import { DIMENSIONS, getScore, listScores, type Dimension, type StoredScore } from './score-store.ts';
import { renderStars } from './stars.ts';
import { keywords, words } from './text.ts';
import { roleSimilarity } from './roles.ts';

/** PRD §5.4a step 3, in order. */
export const WIDEN_ORDER = ['adjacent', 'since:30d', 'since:60d', 'nearby_remote', 'slow_sources'] as const;

export interface TopInput {
  limit: number;
  offset: number;
  /** Variant: only jobs in this district ("Kandy"), or "nearby". */
  district?: string;
  /** Variant: only remote jobs. */
  remote?: boolean;
  /** Variant: rank by likeness to this job (id or "#n"). */
  like?: string;
  /** The agent's "How your CV reads to this market" paragraph. */
  summary?: string;
  /** Return `page_markdown` (the page as shown to the person) instead of `rows`. */
  brief?: boolean;
}

export interface TopRow {
  n: number;
  job_id: string;
  stars: number;
  fit: string;
  points: number;
  capped_by: string | null;
  scam: boolean;
  title: string;
  company: string | null;
  location: string | null;
  closing_date: string | null;
  apply_via: string;
  /** Link to the ad (its page on the job site, or the apply link when there is no ad page). */
  url: string | null;
  /** The employer's own apply link, when the ad gives one. */
  apply_url: string | null;
  why: string | null;
  new: boolean;
}

interface Scored {
  job: MatchJob;
  score: StoredScore;
}

function byRank(a: Scored, b: Scored): number {
  return (
    b.score.stars - a.score.stars ||
    b.score.points - a.score.points ||
    (a.job.closing_date ?? '9999-99-99').localeCompare(b.job.closing_date ?? '9999-99-99') ||
    a.job.id.localeCompare(b.job.id)
  );
}

export function applyVia(j: MatchJob): string {
  if (j.apply_url) {
    try {
      return new URL(j.apply_url).hostname.replace(/^www\./, '');
    } catch {
      /* fall through */
    }
  }
  return j.apply_email ?? j.apply_phone ?? j.platform;
}

/** The link to open for a job: the ad page it was found on, else its apply link. */
export function jobUrl(j: Pick<MatchJob, 'source_url' | 'apply_url'>): string | null {
  for (const u of [j.source_url, j.apply_url]) {
    if (u && /^https?:\/\//i.test(u.trim())) return u.trim();
  }
  return null;
}

/** A Markdown link cell; characters that would break the link or the table are percent-encoded. */
function linkCell(url: string | null, label = 'View ad'): string {
  if (!url) return '—';
  const safe = url.replace(/[\s()<>|\[\]]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  return `[${label}](${safe})`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string | null, withYear = false): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

function cell(s: string | null | undefined): string {
  return (s ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';
}

function toRow(n: number, s: Scored, isNew: boolean): TopRow {
  const scam = s.score.capped_by === 'scam';
  return {
    n,
    job_id: s.job.id,
    stars: s.score.stars,
    fit: `${scam ? '⚠️ ' : ''}${renderStars(s.score.stars)}`,
    points: s.score.points,
    capped_by: s.score.capped_by,
    scam,
    title: s.job.title,
    company: s.job.company,
    location: s.job.location,
    closing_date: s.job.closing_date,
    apply_via: applyVia(s.job),
    url: jobUrl(s.job),
    apply_url: s.job.apply_url,
    why: s.score.why,
    new: isNew,
  };
}

/** Re-ranks the remaining pool for "more like #3": likeness to the anchor first, fit second. */
function likeOrder(anchor: MatchJob, items: Scored[]): Scored[] {
  const index = new MiniSearch({ fields: ['title', 'description'], idField: 'id', tokenize: (s) => words(s) });
  index.addAll(items.map((s) => ({ id: s.job.id, title: s.job.title, description: s.job.description })));
  const hits = index.search(keywords(`${anchor.title} ${anchor.title} ${anchor.description}`, 30).join(' '), { combineWith: 'OR', boost: { title: 1.5 } });
  const max = hits.reduce((m, h) => Math.max(m, h.score), 0) || 1;
  const bm = new Map(hits.map((h) => [String(h.id), h.score / max]));
  const sim = (s: Scored) =>
    Math.round((0.35 * roleSimilarity(s.job.title, anchor.title) + 0.25 * (bm.get(s.job.id) ?? 0) + 0.4 * (s.score.points / 100)) * 1e4) / 1e4;
  return [...items].sort((a, b) => sim(b) - sim(a) || byRank(a, b));
}

function reportPath(ctx: Context, date: string): string {
  return path.join(ctx.paths.reportsDir, `${date}-top20.md`);
}

function sitesCount(ctx: Context, today: string): number {
  return ctx
    .db()
    .prepare(
      `SELECT COUNT(DISTINCT s.source) FROM job_sources s JOIN jobs j ON j.id = s.job_id
        WHERE j.closed_at IS NULL AND (j.closing_date IS NULL OR j.closing_date >= ?)`,
    )
    .pluck()
    .get(today) as number;
}

export interface Gap {
  gap: string;
  count: number;
  jobs: number[];
}

/** The gaps that recur most across rows (agent-written gap phrases, case-insensitive). */
export function recurringGaps(rows: { n: number; gaps: string[] }[], max = 10): Gap[] {
  const m = new Map<string, Gap>();
  for (const r of rows) {
    for (const g of new Set(r.gaps.map((x) => x.trim()).filter(Boolean))) {
      const k = g.toLowerCase();
      const e = m.get(k) ?? { gap: g, count: 0, jobs: [] };
      if (!e.jobs.includes(r.n)) {
        e.count++;
        e.jobs.push(r.n);
      }
      m.set(k, e);
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.gap.localeCompare(b.gap)).slice(0, max);
}

const CLOSING_LINE = 'Say **"CV for #2"** to get a tailored CV, **"why #5?"** for the full breakdown, or **"more jobs"** for the next 20.';

/** The pieces of the day's report: the header lines and a table for any set of numbers. */
function reportParts(ctx: Context, r: DayReport, info: { open: number; scored: number; sites: number }) {
  const ids = r.numbered;
  const jobs = jobsById(ctx.db(), ids);
  const line = (n: number): string => {
    const id = ids[n - 1];
    const job = jobs.get(id);
    const score = job ? getScore(ctx.db(), id, r.resume_hash, r.rubric_version) : null;
    if (!job || !score) return `| ${n} | — | (job ${id} no longer stored) | | | | | | |`;
    const row = toRow(n, { job, score }, false);
    const closed = isOpen(job, r.report_date) ? '' : ' (closed)';
    return `| ${n} | ${row.fit} | ${cell(job.title)}${closed} | ${cell(job.company)} | ${cell(job.location)} | ${shortDate(job.closing_date)} | ${cell(row.apply_via)} | ${linkCell(row.url)} | ${cell(score.why)} |`;
  };
  const table = (numbers: number[]) => [
    '| # | Fit | Role | Company | Location | Closes | Apply via | Link | Why |',
    '|---|-----|------|---------|----------|--------|-----------|------|-----|',
    ...numbers.map(line),
  ];
  const fmt = (n: number) => n.toLocaleString('en-US');
  const header: string[] = [
    `## Your top ${ctx.config().settings.top_n} — ${shortDate(r.report_date, true)} (scanned ${fmt(info.open)} open jobs from ${info.sites} site${info.sites === 1 ? '' : 's'})`,
    '',
    `_Showing ${fmt(ids.length)} of ${fmt(info.scored)} scored, ${fmt(info.open)} open._`,
    '',
  ];
  if (r.summary) header.push(`**How your CV reads to this market:** ${r.summary.trim()}`, '');
  return { header, table };
}

function writeReport(ctx: Context, r: DayReport, info: { open: number; scored: number; sites: number }) {
  const { header, table } = reportParts(ctx, r, info);
  const out: string[] = [...header];
  r.pages.forEach((p, i) => {
    if (i > 0) {
      const lo = Math.min(...p.numbers);
      const hi = Math.max(...p.numbers);
      out.push(`## #${lo}–#${hi}${p.label ? ` (${p.label})` : ''}`, '');
    }
    out.push(...table(p.numbers), '');
  });
  out.push(CLOSING_LINE, '');
  fs.mkdirSync(ctx.paths.reportsDir, { recursive: true });
  const file = reportPath(ctx, r.report_date);
  fs.writeFileSync(file, out.join('\n'));
  return file;
}

/**
 * One page as it is shown in chat (`top --brief`): the header for page 1, a `## #21–#40` heading for later
 * pages, the table for exactly these numbers and the closing line. Same lines as the report file.
 */
function pageMarkdown(ctx: Context, r: DayReport, info: { open: number; scored: number; sites: number }, numbers: number[], label: string | null): string {
  if (!numbers.length) return '';
  const { header, table } = reportParts(ctx, r, info);
  const lo = Math.min(...numbers);
  const hi = Math.max(...numbers);
  const head = lo === 1 ? header : [`## #${lo}–#${hi}${label ? ` (${label})` : ''}`, '', header[2], ''];
  return [...head, ...table(numbers), '', CLOSING_LINE].join('\n');
}

function widenedOptions(widened: string[]): PoolOptions {
  const opts: PoolOptions = {};
  if (widened.includes('adjacent')) opts.titles = ['adjacent'];
  const since = widened
    .filter((w) => w.startsWith('since:'))
    .map((w) => w.slice(6))
    .sort((a, b) => (a === 'all' ? 1 : b === 'all' ? -1 : parseInt(a) - parseInt(b)))
    .pop();
  if (since) opts.since = since;
  if (widened.includes('nearby_remote')) opts.district = 'nearby';
  return opts;
}

function flags(o: PoolOptions): string {
  return [o.titles ? `--titles ${o.titles.join(',')}` : '', o.since ? `--since ${o.since}` : '', o.district ? `--district ${o.district}` : '']
    .filter(Boolean)
    .join(' ');
}

export interface NextStep {
  step: 'already_scored' | 'score_deeper' | 'widen' | 'exhausted' | 'unknown';
  widen?: string;
  command?: string;
  message: string;
}

function nextStep(ctx: Context, r: DayReport, remainingScored: number, limit: number, nextOffset: number, open: number): NextStep {
  if (remainingScored >= limit) {
    return { step: 'already_scored', command: `slj top --offset ${nextOffset} --limit ${limit} --brief --json`, message: `${remainingScored} scored jobs are not shown yet; "more jobs" costs no scoring.` };
  }
  const pn = ctx.config().settings.prefilter_n;
  const opts = widenedOptions(r.widened);
  let pool;
  try {
    pool = buildPool(ctx, opts);
  } catch (err) {
    if (err instanceof SljError) return { step: 'unknown', message: err.message };
    throw err;
  }
  const first = pool.ranked.findIndex((x) => !x.scored);
  if (first >= 0) {
    const unscored = pool.ranked.filter((x) => !x.scored).length;
    const offset = Math.floor(first / pn) * pn;
    return {
      step: 'score_deeper',
      command: `slj match prefilter --offset ${offset} --limit ${pn} ${flags(opts)} --json`.replace(/\s+/g, ' '),
      message: `${unscored} matching jobs are not scored yet. Score the next batch, then run top again.`,
    };
  }
  const next = WIDEN_ORDER.find((w) => !r.widened.includes(w) && !(w === 'since:30d' && r.widened.some((x) => x === 'since:60d' || x === 'since:all')));
  if (next) {
    const o = { ...opts };
    if (next === 'adjacent') o.titles = ['adjacent'];
    if (next.startsWith('since:')) o.since = next.slice(6);
    if (next === 'nearby_remote') o.district = 'nearby';
    const command =
      next === 'slow_sources'
        ? `slj jobs scan --slow --json, then slj match prefilter --offset 0 --limit ${pn} ${flags(o)} --widened slow_sources --json`
        : `slj match prefilter --offset 0 --limit ${pn} ${flags(o)} --json`;
    const say: Record<string, string> = {
      adjacent: 'Widening to adjacent job titles.',
      'since:30d': 'Widening to jobs posted in the last 30 days.',
      'since:60d': 'Widening to jobs posted in the last 60 days.',
      nearby_remote: 'Widening to nearby districts and remote jobs.',
      slow_sources: 'Scanning the slow sources (employer job boards, smaller job sites and governmentjobs.lk).',
    };
    return { step: 'widen', widen: next, command: command.replace(/ +/g, ' '), message: say[next] };
  }
  return { step: 'exhausted', message: `All ${r.numbered.length} matching jobs have been shown. There are ${open} open jobs in total.` };
}

export function top(ctx: Context, input: TopInput) {
  const key = matchKey(ctx);
  const db = ctx.db();
  const open = openJobs(db, key.today);
  const openById = new Map(open.map((j) => [j.id, j]));
  const scores = new Map(listScores(db, key.resume_hash, key.rubric_version).map((s) => [s.job_id, s]));

  const all: Scored[] = [];
  let stale = 0;
  for (const j of open) {
    const s = scores.get(j.id);
    if (!s) continue;
    if (s.job_hash !== j.job_hash) {
      stale++;
      continue;
    }
    all.push({ job: j, score: s });
  }
  all.sort(byRank);

  let report = loadDayReport(db, key);
  report.rubric_version = key.rubric_version;
  const numbered = [...report.numbered];
  const numberOf = new Map(numbered.map((id, i) => [id, i + 1]));
  const firstPage = report.pages.length === 0;
  const fresh: number[] = [];
  const assign = (s: Scored) => {
    numbered.push(s.job.id);
    const n = numbered.length;
    numberOf.set(s.job.id, n);
    fresh.push(n);
    return n;
  };
  const remaining = () => all.filter((s) => !numberOf.has(s.job.id));

  const variant = !!(input.district || input.remote || input.like);
  let rows: TopRow[];
  let label: string | null = null;
  const dropped: { n: number; job_id: string; reason: string }[] = [];

  if (!variant) {
    // The displayed sequence: today's numbered jobs that are still open, then new numbers in rank order.
    const shown: Scored[] = [];
    numbered.forEach((id, i) => {
      const j = openById.get(id);
      const s = scores.get(id);
      if (!j) dropped.push({ n: i + 1, job_id: id, reason: 'closed' });
      else if (s) shown.push({ job: j, score: s });
    });
    const rest = remaining();
    while (shown.length < input.offset + input.limit && rest.length) {
      const s = rest.shift()!;
      assign(s);
      shown.push(s);
    }
    rows = shown.slice(input.offset, input.offset + input.limit).map((s) => toRow(numberOf.get(s.job.id)!, s, fresh.includes(numberOf.get(s.job.id)!)));
  } else {
    let pool = remaining();
    const labels: string[] = [];
    if (input.district) {
      const raw = input.district.trim().toLowerCase();
      if (raw === 'nearby') {
        // "nearby" = the profile's districts and their neighbours, plus remote: the prefilter's location gate.
        const ok = new Set(buildPool(ctx, { district: 'nearby', titles: ['any'], since: 'all' }).ranked.map((r) => r.job.id));
        pool = pool.filter((s) => ok.has(s.job.id));
        labels.push('nearby');
      } else {
        const d = placeOf(raw).district ?? raw;
        pool = pool.filter((s) => s.job.district === d);
        labels.push(`in ${d.replace(/\b\w/g, (c) => c.toUpperCase())}`);
      }
    }
    if (input.remote) {
      pool = pool.filter((s) => s.job.remote);
      labels.push('remote only');
    }
    if (input.like) {
      const id = jobRef(db, key, input.like);
      const anchor = jobsById(db, [id]).get(id);
      if (!anchor) throw new SljError('NOT_FOUND', `No job with id ${id}.`);
      pool = likeOrder(anchor, pool.filter((s) => s.job.id !== id));
      labels.push(`like #${numberOf.get(id) ?? id}`);
    }
    label = labels.join(', ');
    rows = pool.slice(0, input.limit).map((s) => toRow(assign(s), s, true));
  }

  if (firstPage && rows.length) report.pages.push({ label: null, numbers: rows.map((r) => r.n) });
  else if (fresh.length) report.pages.push({ label, numbers: fresh });

  if (input.summary != null) report.summary = input.summary.trim() || null;
  report.numbered = numbered;
  report.pool_size = all.length;
  const changed = fresh.length > 0 || input.summary != null || report.id == null;
  if (changed) report = saveDayReport(db, report, ctx.now());

  const sites = sitesCount(ctx, key.today);
  let file: string | null = null;
  if (report.pages.length) file = writeReport(ctx, report, { open: open.length, scored: all.length, sites });
  if (fresh.length) bumpStat(ctx, 'top_reports');

  // Recurring gaps across the day's top 20 (by number), for the "How your CV reads" paragraph.
  const topN = ctx.config().settings.top_n;
  const gaps = recurringGaps(
    numbered
      .slice(0, topN)
      .map((id, i) => ({ n: i + 1, gaps: openById.has(id) ? scores.get(id)?.gaps ?? [] : [] })),
  );
  const remainingScored = remaining().length;

  const info = { open: open.length, scored: all.length, sites };
  // Scam-capped rows are always named, so a brief result still tells the agent which numbers to warn about.
  const scams = rows.filter((r) => r.scam).map((r) => r.n);
  return {
    today: key.today,
    resume_hash: key.resume_hash,
    rubric_version: key.rubric_version,
    variant: variant ? label : null,
    shown: rows.length,
    ...(input.brief
      ? { page_markdown: pageMarkdown(ctx, report, info, rows.map((r) => r.n), label), scam_rows: scams }
      : { rows }),
    short_by: Math.max(0, input.limit - rows.length),
    dropped,
    pool: { open: open.length, scored: all.length, stale_scores: stale, numbered_today: numbered.length, remaining_scored: remainingScored, sites },
    recurring_gaps: gaps,
    summary: report.summary,
    widened: report.widened,
    report_file: file,
    next_step: nextStep(ctx, report, remainingScored, input.limit, variant ? input.offset : input.offset + input.limit, open.length),
  };
}

// ---------------------------------------------------------------- why / resolve

export function topResolve(ctx: Context, n: string | number) {
  const key = matchKey(ctx);
  const r = loadDayReport(ctx.db(), key);
  const id = resolveNumber(r, n);
  const job = jobsById(ctx.db(), [id]).get(id);
  return { n: parseNumber(n), job_id: id, title: job?.title ?? null, company: job?.company ?? null, open: job ? isOpen(job, key.today) : false, today: key.today };
}

export function topWhy(ctx: Context, n: string | number) {
  const key: MatchKey = matchKey(ctx);
  const r = loadDayReport(ctx.db(), key);
  const id = resolveNumber(r, n);
  const job = jobsById(ctx.db(), [id]).get(id);
  const s = getScore(ctx.db(), id, key.resume_hash, key.rubric_version);
  if (!job || !s) throw new SljError('NOT_FOUND', `#${parseNumber(n)} (${id}) has no saved score for this CV and rubric.`);
  return {
    n: parseNumber(n),
    job_id: id,
    title: job.title,
    company: job.company,
    location: job.location,
    closing_date: job.closing_date,
    apply_via: applyVia(job),
    url: jobUrl(job),
    apply_url: job.apply_url,
    open: isOpen(job, key.today),
    stale: s.job_hash !== job.job_hash,
    points: s.points,
    stars: s.stars,
    fit: `${s.capped_by === 'scam' ? '⚠️ ' : ''}${renderStars(s.stars)}`,
    stars_before_caps: s.raw_stars,
    capped_by: s.capped_by,
    dimensions: (Object.keys(DIMENSIONS) as Dimension[]).map((d) => ({ dimension: d, points: s.dimensions[d] ?? 0, max: DIMENSIONS[d] })),
    requirements: s.requirements,
    matched: s.matched,
    gaps: s.gaps,
    missing_mandatory: s.missing_mandatory,
    scam_signals: s.scam_signals,
    why: s.why,
    model: s.model,
    scored_at: s.created_at,
  };
}

export function formatWhy(d: ReturnType<typeof topWhy>): string {
  const label: Record<string, string> = {
    role_fit: 'Role / title fit', must_haves: 'Must-have requirements', seniority: 'Seniority / years',
    education: 'Education and qualifications', location: 'Location / work mode', domain: 'Domain / industry',
  };
  const caps =
    d.capped_by === 'scam'
      ? `Capped at 1 star: scam signal (${d.scam_signals.join('; ')})`
      : d.capped_by === 'missing_mandatory'
        ? `Capped at 2 stars: missing mandatory ${d.missing_mandatory.join('; ')}`
        : 'No caps applied';
  return [
    `### #${d.n} ${d.title}${d.company ? ` — ${d.company}` : ''}: ${d.fit} (${d.points}/100)`,
    '',
    d.url ? `Ad: ${d.url}` : '',
    d.apply_url && d.apply_url !== d.url ? `Apply: ${d.apply_url}` : '',
    '',
    '| Dimension | Points |',
    '|---|---|',
    ...d.dimensions.map((x) => `| ${label[x.dimension]} | ${x.points} / ${x.max} |`),
    `| **Total** | **${d.points} / 100** |`,
    '',
    '| Requirement | From the ad | Status |',
    '|---|---|---|',
    ...d.requirements.map((q) => `| ${cell(q.text)}${q.mandatory ? ' (mandatory)' : ''} | "${cell(q.jd_quote)}" | ${q.status} |`),
    '',
    caps + (d.stars_before_caps !== d.stars ? ` (points alone give ${d.stars_before_caps} stars)` : ''),
    d.why ? `Why: ${d.why}` : '',
    d.stale ? 'Note: the ad changed after this score; it will be re-scored on the next prefilter.' : '',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
}
