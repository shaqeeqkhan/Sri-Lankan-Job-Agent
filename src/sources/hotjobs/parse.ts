/**
 * HotJobs.lk parsing (pure, fixture-tested).
 *
 * Verified 2026-11-15 against the live site:
 * - `https://hotjobs.lk/sitemap/jobs.xml` lists every open posting (~500) as
 *   `https://hotjobs.lk/jobs/<slug>/<id>` with a `<lastmod>`. The numeric id is the posting id
 *   ("Ref. No 00008745" on the page); the slug is ignored by the site.
 * - A job page (Next.js app router) carries schema.org `JobPosting` JSON-LD (title, company,
 *   locality, datePosted, validThrough) and, in the `self.__next_f.push` flight payload, the full
 *   job object (`jobPostId`, `status`, `expireDate`, HTML `description`, `salary`, `enumData`
 *   with location / country / category / workplace type, `receiveApplications`, `jobAdvertImage`).
 *   A long description may be a flight reference (`"$48"`) to a text chunk `48:T<hex len>,<text>`.
 * - A posting that is gone answers a real HTTP 404.
 */
import type { ScrapedJob } from '../types.ts';

export const HOST = 'https://hotjobs.lk';
export const SITEMAP_URL = `${HOST}/sitemap/jobs.xml`;

export interface SitemapEntry {
  url: string;
  external_id: string;
  lastmod: string | null;
}

const JOB_URL_RE = /^https?:\/\/(?:www\.)?hotjobs\.lk\/jobs\/[^/?#]+\/(\d+)\/?(?:[?#].*)?$/i;

/** The posting id from a job URL (`/jobs/<slug>/<id>`), or null. */
export function externalIdFromUrl(url: string): string | null {
  return url.trim().match(JOB_URL_RE)?.[1] ?? null;
}

/** Job entries in the jobs sitemap, newest (highest id) first. Non-job URLs are skipped. */
export function parseSitemap(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (!loc) continue;
    const url = decodeXml(loc);
    const id = externalIdFromUrl(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ url, external_id: id, lastmod: m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1] ?? null });
  }
  return out.sort((a, b) => Number(b.external_id) - Number(a.external_id));
}

export function isSitemap(xml: string): boolean {
  return /<urlset[\s>]/.test(xml);
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------- flight payload

/** The concatenated Next.js flight stream (`self.__next_f.push([1,"…"])` strings, decoded). */
export function decodeFlight(html: string): string {
  let out = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      out += JSON.parse(m[1]) as string;
    } catch {
      // A chunk that does not decode is skipped.
    }
  }
  return out;
}

/** The balanced JSON object starting at `start` (which must be `{`), or null. */
function balancedObject(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export type HotJobsRecord = Record<string, unknown> & { jobPostId?: string };

/** The `"job":{…}` object in the flight stream whose `jobPostId` is `id` (sidebars carry other jobs). */
export function findJobRecord(flight: string, id: string): HotJobsRecord | null {
  let i = flight.indexOf('"job":{');
  while (i >= 0) {
    const raw = balancedObject(flight, i + 6);
    if (raw) {
      try {
        const o = JSON.parse(raw) as HotJobsRecord;
        if (String(o.jobPostId ?? '') === id) return o;
      } catch {
        // not JSON: keep looking
      }
    }
    i = flight.indexOf('"job":{', i + 7);
  }
  return null;
}

/** Resolves a flight text reference such as `"$48"` to its `48:T<hex>,<text>` chunk. */
export function resolveFlightText(flight: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ref = value.match(/^\$([0-9a-f]+)$/i);
  if (!ref) return value;
  const m = new RegExp(`(?:^|[^0-9a-zA-Z])${ref[1]}:T([0-9a-f]+),`).exec(flight);
  if (!m) return null;
  const bytes = parseInt(m[1], 16);
  const rest = Buffer.from(flight.slice(m.index + m[0].length), 'utf8');
  return rest.subarray(0, bytes).toString('utf8');
}

// ---------------------------------------------------------------- JSON-LD helpers

export function findJobPosting(jsonLd: unknown[]): Record<string, any> | null {
  const stack: unknown[] = [...jsonLd];
  while (stack.length) {
    const x = stack.shift();
    if (Array.isArray(x)) stack.push(...x);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, any>;
      const t = o['@type'];
      if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return o;
      if (Array.isArray(o['@graph'])) stack.push(...o['@graph']);
    }
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s : null;
}
function first(v: unknown): string | null {
  return Array.isArray(v) ? str(v[0]) : str(v);
}
export function isoDay(v: unknown): string | null {
  const m = typeof v === 'string' ? v.trim().match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return m ? m[1] : null;
}
/** Today in Sri Lanka (UTC+05:30), as YYYY-MM-DD. */
export function todayLk(now: Date): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
function textLength(html: string | null): number {
  return (html ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length;
}
function httpUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
function money(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const COUNTRY_CODES: Record<string, string> = {
  'sri lanka': 'LK', oman: 'OM', qatar: 'QA', 'saudi arabia': 'SA', 'united arab emirates': 'AE', uae: 'AE',
  kuwait: 'KW', bahrain: 'BH', maldives: 'MV', malaysia: 'MY', singapore: 'SG', japan: 'JP',
  'south korea': 'KR', israel: 'IL', romania: 'RO', poland: 'PL', 'united kingdom': 'GB', australia: 'AU',
};

/** HotJobs salary: `{fromSalary, salary, currency, type}` or the free text `salaryValue`. */
export function salaryText(rec: HotJobsRecord | null): string | null {
  if (!rec) return null;
  const s = rec.salary as Record<string, unknown> | undefined;
  if (s && typeof s === 'object') {
    const to = Number(s.salary);
    const from = Number(s.fromSalary);
    if (Number.isFinite(to) && to > 0) {
      // The currency is an internal id ("1"); it is not shown, so it is not guessed here.
      const figure = Number.isFinite(from) && from > 0 && from !== to ? `${money(from)}–${money(to)}` : money(to);
      const per = str(s.type);
      return per ? `${figure} / ${per.toLowerCase()}` : figure;
    }
  }
  return str(rec.salaryValue);
}

export interface HotJobsDetail {
  job: ScrapedJob | null;
  /** From the job record: false when its status is not Active; null when unknown. */
  active: boolean | null;
}

/**
 * One job page → a ScrapedJob. Structured values (JSON-LD, the job record) only; nothing is
 * read from the description text. Returns job=null when neither source is on the page (drift).
 */
export function parseDetail(html: string, jsonLd: unknown[], url: string, now: Date): HotJobsDetail {
  const id = externalIdFromUrl(url);
  if (!id) return { job: null, active: null };
  const ld = findJobPosting(jsonLd);
  const flight = decodeFlight(html);
  const rec = findJobRecord(flight, id);
  // JSON-LD on other pages (e.g. the 404 page) belongs to other jobs: only trust ours.
  const ldOk = ld && (typeof ld.url !== 'string' || externalIdFromUrl(ld.url) === id) ? ld : null;
  if (!ldOk && !rec) return { job: null, active: null };

  const en = (rec?.enumData ?? {}) as Record<string, unknown>;
  const title = str(rec?.jobTitle) ?? str(ldOk?.title);
  if (!title) return { job: null, active: null };

  const addr = (Array.isArray(ldOk?.jobLocation) ? ldOk?.jobLocation[0] : ldOk?.jobLocation)?.address ?? {};
  const country = first(en.country);
  const foreign = rec?.isForeignJob === true || (country !== null && country.toLowerCase() !== 'sri lanka');
  const places = Array.isArray(en.location) ? (en.location as unknown[]).map(str).filter((x): x is string => !!x) : [];
  let location = places.length ? places.join(', ') : str(addr.addressLocality);
  if (location && foreign && country && !location.toLowerCase().includes(country.toLowerCase())) location = `${location}, ${country}`;
  const country_code = country ? (COUNTRY_CODES[country.toLowerCase()] ?? null) : foreign ? null : 'LK';

  const workplace = first(en.workplaceType)?.toLowerCase() ?? null;
  const remote = workplace === null ? null : workplace === 'remote' ? true : workplace === 'on-site' || workplace === 'onsite' ? false : null;

  const description = resolveFlightText(flight, rec?.description) ?? str(ldOk?.description);
  const image = str(rec?.jobAdvertImage);
  // "portal": apply on HotJobs itself. "external": the ad links the employer's own page
  // (`receiveApplicationsUrl`); the method is left for `jobs scan` to infer from the link.
  // The recruiter inbox (`receiveApplicationToEmail`) is never shown in the ad, so it is never used.
  const portal = rec?.receiveApplications === 'portal';
  const externalUrl = rec?.receiveApplications === 'external' ? httpUrl(rec.receiveApplicationsUrl) : null;
  const status = str(rec?.status);

  const job: ScrapedJob = {
    title,
    company: str(ldOk?.hiringOrganization?.name) ?? (rec?.isAnonymous === true ? null : str(rec?.recruiterName)),
    location,
    category: first(en.jobCategory),
    salary_text: salaryText(rec),
    description,
    closing_date: isoDay(ldOk?.validThrough) ?? isoDay(rec?.expireDate),
    posted_at: isoDay(ldOk?.datePosted) ?? isoDay(rec?.activeDate),
    apply_method: portal ? 'portal' : null,
    apply_url: portal ? url : externalUrl,
    is_image_ad: image !== null && textLength(description) < 200,
    employment_type: first(en.employmentType) ?? first(ldOk?.employmentType),
    remote,
    country_code,
    external_id: id,
    source_url: url,
    scraped_at: now.toISOString(),
  };
  return { job, active: status === null ? null : status.toLowerCase() === 'active' };
}

/** What the ladder should see on a job page: JSON-LD or the job record. */
export function looksLikeJobPage(html: string): boolean {
  return html.includes('JobPosting') || html.includes('jobPostId');
}
