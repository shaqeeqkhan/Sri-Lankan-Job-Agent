/**
 * Shared pieces of the employer ATS adapters (workday, greenhouse, lever, ashby, smartrecruiters):
 * the Sri Lanka location filter, board-entry parsing, and the field mapping helpers.
 *
 * Ported from ThreatHire's job-scraper (scrapers/*.py, utils/boards.py) minus the US and
 * security-role parts. Every family keeps only Sri Lanka–based roles.
 */
import { SljError } from '../errors.ts';
import type { HttpClient, HttpResponse, ScrapedJob, SourceContext, SourceResult } from './types.ts';
import { detailBudget, mapInOrder } from './util.ts';

export const ATS_FAMILIES = ['workday', 'greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const;
export type AtsFamily = (typeof ATS_FAMILIES)[number];

// ---------------------------------------------------------------- Sri Lanka filter

/**
 * Cities, towns and districts of Sri Lanka as they appear in ATS location lines.
 * Only names that are not common words or common elsewhere; "Ella" is left out on purpose.
 */
export const SRI_LANKA_PLACES = [
  // districts (all 25)
  'Colombo', 'Gampaha', 'Kalutara', 'Kandy', 'Matale', 'Nuwara Eliya', 'Galle', 'Matara', 'Hambantota',
  'Jaffna', 'Kilinochchi', 'Mannar', 'Vavuniya', 'Mullaitivu', 'Batticaloa', 'Ampara', 'Trincomalee',
  'Kurunegala', 'Puttalam', 'Anuradhapura', 'Polonnaruwa', 'Badulla', 'Monaragala', 'Moneragala',
  'Ratnapura', 'Kegalle',
  // cities and suburbs that host offices, BPOs, factories and free-trade zones
  'Sri Jayawardenepura Kotte', 'Sri Jayewardenepura Kotte', 'Kotte', 'Dehiwala', 'Mount Lavinia',
  'Moratuwa', 'Negombo', 'Malabe', 'Kaduwela', 'Battaramulla', 'Rajagiriya', 'Nugegoda', 'Maharagama',
  'Piliyandala', 'Panadura', 'Wattala', 'Ja-Ela', 'Ja Ela', 'Kelaniya', 'Katunayake', 'Biyagama',
  'Horana', 'Avissawella', 'Homagama', 'Seeduwa', 'Kadawatha', 'Ragama', 'Kiribathgoda', 'Kottawa',
  'Pannipitiya', 'Boralesgamuwa', 'Wellawatte', 'Bambalapitiya', 'Kollupitiya', 'Koggala', 'Hikkaduwa',
  'Chilaw', 'Embilipitiya', 'Dambulla', 'Peradeniya', 'Kalmunai', 'Nawala', 'Pelawatte', 'Athurugiriya',
] as const;

const PLACE_RE = new RegExp(
  `(?<![\\p{L}])(${SRI_LANKA_PLACES.map((p) => p.replace(/[-\s]/g, '[-\\s]?')).join('|')})(?![\\p{L}])`,
  'iu',
);
const COUNTRY_NAME_RE = /\bsri[-\s]?lanka\b/i;
/** "LK" / "LKA" as a code: upper case only, as Workday ("LKA-Colombo-…") and others write it. */
const COUNTRY_CODE_RE = /(?<![A-Za-z])(LKA|LK)(?![A-Za-z])/;

/** 'LK' for any spelling of Sri Lanka's code or name, another ISO alpha-2 upper-cased, else null. */
export function countryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (/^(lk|lka)$/i.test(v) || /^sri[-\s]?lanka$/i.test(v)) return 'LK';
  if (/^[a-z]{2}$/i.test(v)) return v.toUpperCase();
  return null;
}

/** True when the text names Sri Lanka itself (country name or LK/LKA code). */
export function textNamesSriLanka(text: string | null | undefined): boolean {
  if (!text) return false;
  return COUNTRY_NAME_RE.test(text) || COUNTRY_CODE_RE.test(text);
}

/** True when the text names Sri Lanka or a Sri Lankan city or district. */
export function textIsSriLanka(text: string | null | undefined): boolean {
  if (!text) return false;
  return textNamesSriLanka(text) || PLACE_RE.test(text);
}

/**
 * Is this posting based in Sri Lanka?
 *
 * - A structured country field decides when it is Sri Lanka.
 * - When it names another country, only an explicit "Sri Lanka" / "LK" in one of the location
 *   lines keeps the posting (a multi-office role whose primary office is elsewhere). A bare city
 *   name does not: "Colombo" with country BR is Colombo, Paraná.
 * - With no country field, the location text decides (country name, code, or a Sri Lankan place).
 */
export function isSriLanka(p: { country?: unknown; locations?: (string | null | undefined)[] }): boolean {
  const locs = (p.locations ?? []).filter((l): l is string => typeof l === 'string' && l.trim() !== '');
  const cc = countryCode(p.country);
  if (cc === 'LK') return true;
  if (cc) return locs.some(textNamesSriLanka);
  return locs.some(textIsSriLanka);
}

// ---------------------------------------------------------------- boards

export interface Board {
  family: AtsFamily;
  /** The entry as written in boards.json: a slug, or `tenant|wdN|site` for Workday. */
  name: string;
  /** Display name of the employer, when the entry gives one. */
  company: string | null;
}
export interface WorkdayBoard extends Board {
  family: 'workday';
  tenant: string;
  wd: string;
  site: string;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * One boards.json entry → a Board. An entry is a string (the board name) or an object
 * `{ name, company }`. Workday names are `tenant|wdN|site`. Throws INVALID_INPUT on a bad entry.
 */
export function parseBoardEntry(family: AtsFamily, entry: unknown): Board {
  let name: unknown;
  let company: unknown = null;
  if (typeof entry === 'string') name = entry;
  else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const o = entry as Record<string, unknown>;
    name = o.name ?? o.board ?? o.slug;
    company = o.company ?? null;
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw new SljError('INVALID_INPUT', `A ${family} board needs a name: ${JSON.stringify(entry)}`, { family, entry });
  }
  name = name.trim();
  const display = typeof company === 'string' && company.trim() ? company.trim() : null;
  if (family === 'workday') {
    const parts = (name as string).split('|').map((s) => s.trim());
    if (parts.length !== 3 || !/^[a-z0-9-]+$/i.test(parts[0]) || !/^wd\d+$/i.test(parts[1]) || !/^[A-Za-z0-9_.-]+$/.test(parts[2])) {
      throw new SljError('INVALID_INPUT', `A Workday board is "tenant|wdN|site" (e.g. "lseg|wd3|Careers"), not "${name}".`, { family, entry });
    }
    const [tenant, wd, site] = parts;
    const t = tenant.toLowerCase();
    const w = wd.toLowerCase();
    return { family, name: `${t}|${w}|${site}`, company: display, tenant: t, wd: w, site } as WorkdayBoard;
  }
  if (!SLUG_RE.test(name as string)) {
    throw new SljError('INVALID_INPUT', `Not a valid ${family} board slug: "${name}".`, { family, entry });
  }
  return { family, name: name as string, company: display };
}

/** The family's boards from ctx.boards; a bad entry is logged and skipped. */
export function boardsFor<B extends Board = Board>(ctx: SourceContext, family: AtsFamily): B[] {
  const out: B[] = [];
  const seen = new Set<string>();
  for (const entry of ctx.boards?.[family] ?? []) {
    try {
      const b = parseBoardEntry(family, entry) as B;
      const key = b.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(b);
    } catch (err) {
      ctx.log(`${family}: skipping board entry ${JSON.stringify(entry)}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * A careers URL → its family and board name, for `boards check <url>`.
 * Returns null for anything that is not a recognised ATS board URL.
 */
export function boardFromUrl(raw: string): { family: AtsFamily; name: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  const wd = host.match(/^([a-z0-9-]+)\.(wd\d+)\.(myworkdayjobs|myworkdaysite)\.com$/);
  if (wd) {
    const rest = segs[0] && /^[a-z]{2}-[A-Z]{2}$/.test(segs[0]) ? segs.slice(1) : segs;
    if (rest[0] === 'recruiting' && rest[2]) return { family: 'workday', name: `${wd[1]}|${wd[2]}|${rest[2]}` };
    if (rest[0]) return { family: 'workday', name: `${wd[1]}|${wd[2]}|${rest[0]}` };
    return null;
  }
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    if (host.startsWith('boards-api')) {
      const i = segs.indexOf('boards');
      return i >= 0 && segs[i + 1] ? { family: 'greenhouse', name: segs[i + 1] } : null;
    }
    const slug = u.searchParams.get('for') ?? (segs[0] === 'embed' ? null : segs[0]);
    return slug ? { family: 'greenhouse', name: slug } : null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') return segs[0] ? { family: 'lever', name: segs[0] } : null;
  if (host === 'api.lever.co') return segs[2] ? { family: 'lever', name: segs[2] } : null;
  if (host === 'jobs.ashbyhq.com') return segs[0] ? { family: 'ashby', name: decodeURIComponent(segs[0]) } : null;
  if (host === 'api.ashbyhq.com') return segs[2] ? { family: 'ashby', name: segs[2] } : null;
  if (/(^|\.)smartrecruiters\.com$/.test(host)) {
    if (host.startsWith('api.')) {
      const i = segs.indexOf('companies');
      return i >= 0 && segs[i + 1] ? { family: 'smartrecruiters', name: segs[i + 1] } : null;
    }
    return segs[0] ? { family: 'smartrecruiters', name: segs[0] } : null;
  }
  return null;
}

// ---------------------------------------------------------------- what an adapter exposes for `boards check`

export interface BoardProbe {
  /** The API answered for this board. */
  valid: boolean;
  /** Open postings on the board, every country. null when the API gives no count. */
  total_postings: number | null;
  sri_lanka_postings: number;
  sample_titles: string[];
  /** Employer name as the ATS gives it, when it does. */
  company: string | null;
  /** Why the board is not valid, in plain words. */
  reason?: string;
}

/** Thrown inside an adapter for a board-level failure; the adapter logs it and skips the board. */
export class BoardError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'BoardError';
    this.status = status;
  }
}

// ---------------------------------------------------------------- HTTP + JSON

export const JSON_HEADERS = { Accept: 'application/json' };

/** Parses a response body as JSON; a BoardError on a non-2xx status or a body that is not JSON. */
export function jsonOf<T = any>(res: HttpResponse, what: string): T {
  if (res.status < 200 || res.status >= 300) throw new BoardError(`${what}: HTTP ${res.status}`, res.status);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new BoardError(`${what}: response is not JSON`, res.status);
  }
}

/** Like jsonOf, but null instead of throwing (detail fetches and rechecks). */
export function tryJson<T = any>(res: HttpResponse): T | null {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return null;
  }
}

/** GET that never throws: a network failure becomes status 0. */
export async function safeGet(http: HttpClient, url: string): Promise<HttpResponse> {
  try {
    return await http.get(url, { headers: JSON_HEADERS });
  } catch (err) {
    return { status: 0, url, headers: {}, text: (err as Error).message };
  }
}

// ---------------------------------------------------------------- field mapping

/** YYYY-MM-DD from an ISO-ish string or epoch milliseconds; null when unreadable. */
export function isoDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** Trimmed non-empty string, else null. */
export function str(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** Distinct non-empty location strings joined with "; ", in order. */
export function joinLocations(parts: unknown[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const s = str(p);
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out.length ? out.join('; ') : null;
}

function cut(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function httpUrl(s: unknown): string | null {
  const v = str(s);
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The family-unique external id: `<board>:<posting id>`. */
export function externalId(board: string, postingId: string): string {
  return `${board}:${postingId}`.slice(0, 200);
}

/** Splits an external id made by externalId(). */
export function splitExternalId(id: string): { board: string; posting: string } | null {
  const i = id.lastIndexOf(':');
  if (i <= 0 || i === id.length - 1) return null;
  return { board: id.slice(0, i), posting: id.slice(i + 1) };
}

export interface MappedJob {
  title: unknown;
  company?: unknown;
  location?: unknown;
  category?: unknown;
  salary_text?: unknown;
  description?: unknown;
  closing_date?: unknown;
  apply_url?: unknown;
  posted_at?: unknown;
  country_code?: unknown;
  remote?: boolean | null;
  employment_type?: unknown;
  source_url: string;
  external_id: string;
}

/**
 * A ScrapedJob that fits the JobFields limits: strings trimmed and cut to length, empties dropped,
 * URLs checked, dates as YYYY-MM-DD. Structured ATS values go in as-is (PRD rule 9); nothing here
 * parses free text. Returns null when there is no title.
 */
export function toScrapedJob(m: MappedJob, scrapedAt: Date): ScrapedJob | null {
  const title = cut(str(m.title), 300);
  if (!title) return null;
  const job: ScrapedJob = { title, source_url: m.source_url, external_id: m.external_id, scraped_at: scrapedAt.toISOString() };
  const set = <K extends keyof ScrapedJob>(k: K, v: ScrapedJob[K] | null | undefined) => {
    if (v !== null && v !== undefined) job[k] = v;
  };
  set('company', cut(str(m.company), 200));
  set('location', cut(str(m.location), 200));
  set('category', cut(str(m.category), 100));
  set('salary_text', cut(str(m.salary_text), 200));
  const desc = typeof m.description === 'string' ? m.description.trim() : '';
  if (desc) job.description = desc.length > 100_000 ? desc.slice(0, 100_000) : desc;
  set('closing_date', isoDate(m.closing_date));
  const apply = httpUrl(m.apply_url);
  if (apply) {
    job.apply_url = apply;
    job.apply_method = 'portal';
  }
  set('posted_at', isoDate(m.posted_at));
  set('country_code', countryCode(m.country_code));
  if (typeof m.remote === 'boolean') job.remote = m.remote;
  set('employment_type', cut(str(m.employment_type), 60));
  return job;
}

/** Decodes the HTML entities Greenhouse escapes its `content` with (`&lt;p&gt;` → `<p>`). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** True when the posting date is known and before ctx.since. */
export function beforeSince(ctx: SourceContext, postedAt: string | null | undefined): boolean {
  if (!ctx.since || !postedAt) return false;
  const d = isoDate(postedAt);
  return d !== null && d < ctx.since.toISOString().slice(0, 10);
}

/** Workers for running boards: boards on one shared API host run one at a time. */
export const SHARED_HOST_WORKERS = 1;
/** Workday tenants are each their own host, so several can run at once. */
export const WORKDAY_BOARD_WORKERS = 4;

// ---------------------------------------------------------------- the shared scan loop

/** One Sri Lanka posting found on a board listing. */
export interface Candidate {
  externalId: string;
  /** YYYY-MM-DD when the listing gives one; orders the detail fetches newest first. */
  postedAt: string | null;
  /** Requests for this candidate's detail go to this host; one request at a time per host. */
  hostKey: string;
  /**
   * Builds the job, fetching its detail if the family needs one.
   * null = the detail fetch failed (deferred); 'drop' = the detail shows it is not a Sri Lanka role.
   */
  build(): Promise<ScrapedJob | null | 'drop'>;
}

/**
 * The scan every ATS adapter shares (ThreatHire's per-ATS scrape loop):
 * 1. list each board (concurrently across hosts, `workers` at a time); a failing board is logged
 *    and skipped, and only every board failing is a whole-source error;
 * 2. drop seen and too-old candidates, order the rest newest first, cap at `max_details`;
 * 3. build each job (detail fetch), one request at a time per host; a failed detail is deferred.
 */
export async function runAtsScan<B extends Board>(
  ctx: SourceContext,
  family: AtsFamily,
  workers: number,
  list: (board: B) => Promise<Candidate[]>,
): Promise<SourceResult> {
  const boards = boardsFor<B>(ctx, family);
  if (boards.length === 0) {
    ctx.log(`${family}: no boards in config/boards.json`);
    return { jobs: [], listed: 0, skippedSeen: 0, deferred: [] };
  }
  const errors: string[] = [];
  const listed = await mapInOrder(
    boards,
    async (b) => {
      try {
        const c = await list(b);
        ctx.log(`${family}: ${b.company ?? b.name}: ${c.length} Sri Lanka posting(s)`);
        return c;
      } catch (err) {
        const msg = `${b.name}: ${(err as Error).message}`;
        errors.push(msg);
        ctx.log(`${family}: board failed, skipped (${msg})`);
        return null;
      }
    },
    workers,
  );
  if (listed.every((c) => c === null)) {
    throw new SljError('FETCH_FAILED', `Every ${family} board failed (${boards.length}): ${errors.slice(0, 5).join('; ')}`, { family, errors });
  }

  const byId = new Map<string, Candidate>();
  for (const c of listed.flat()) if (c && !byId.has(c.externalId)) byId.set(c.externalId, c);
  const all = [...byId.values()];
  let skippedSeen = 0;
  const fresh: Candidate[] = [];
  for (const c of all) {
    if (ctx.seen(c.externalId)) skippedSeen++;
    else if (!beforeSince(ctx, c.postedAt)) fresh.push(c);
  }
  // Newest first; a stable sort keeps board order among equal or unknown dates.
  const ordered = fresh
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.postedAt ?? '').localeCompare(a.c.postedAt ?? '') || a.i - b.i)
    .map((x) => x.c);
  const cap = ctx.source.max_details;
  if (ordered.length > cap) ctx.log(`${family}: ${ordered.length} new postings, fetching the newest ${cap}; the rest wait for the next scan`);
  // The newest `cap` are picked before any lane runs (lanes finish in any order); the budget then
  // only stops on time.
  const todo = ordered.slice(0, cap);
  const budget = detailBudget(ctx);
  const taken = new Array<boolean>(todo.length).fill(false);

  // One lane per host: lanes run concurrently, each lane one request at a time.
  const lanes = new Map<string, number[]>();
  todo.forEach((c, i) => {
    const lane = lanes.get(c.hostKey) ?? [];
    lane.push(i);
    lanes.set(c.hostKey, lane);
  });
  const built = new Array<ScrapedJob | null | 'drop'>(todo.length);
  await mapInOrder(
    [...lanes.values()],
    async (idxs) => {
      for (const i of idxs) {
        if (!budget.take()) continue;
        taken[i] = true;
        try {
          built[i] = await todo[i].build();
        } catch {
          built[i] = null;
        }
      }
    },
    workers,
  );
  const jobs: ScrapedJob[] = [];
  const deferred: string[] = [];
  const dropped: string[] = [];
  built.forEach((j, i) => {
    if (!taken[i]) return;
    if (j === null) deferred.push(todo[i].externalId);
    else if (j === 'drop') dropped.push(todo[i].externalId); // read: not a Sri Lanka role
    else jobs.push(j);
  });
  if (deferred.length) ctx.log(`${family}: ${deferred.length} detail fetch(es) failed, deferred to the next scan`);
  ctx.log(`${family}: ${jobs.length} job(s) from ${boards.length - errors.length}/${boards.length} board(s)`);
  const overCap = Math.max(0, ordered.length - todo.length);
  const timeCut = budget.truncation();
  const truncated = timeCut
    ? { reason: 'time' as const, left: timeCut.left + overCap }
    : overCap > 0 ? { reason: 'max_details' as const, left: overCap } : undefined;
  return { jobs, listed: all.length, skippedSeen, deferred, dropped, truncated };
}


