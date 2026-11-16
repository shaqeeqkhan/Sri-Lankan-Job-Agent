/**
 * Rooster (rooster.jobs) parsing (pure, fixture-tested).
 *
 * Verified 2026-11-15 against the live site:
 * - Rooster's own front end searches with `POST https://api.rooster.jobs/jobSearch/jobs/search`,
 *   body `{query: [], limit, page, filters: {country: "Sri Lanka"}}`. The answer is
 *   `{status, message, body: {count, facets, data: [...]}}`; each item carries the full Markdown
 *   description, location text, company, job type, remote flag, class/subclass, created_at and,
 *   for about a third, min/max salary with currency and frequency. There is no closing date.
 *   ~1,230 postings in all, ~1,070 in Sri Lanka; the rest are other countries (hence the filter).
 * - The job page `https://rooster.jobs/jobs/<id>` (Next.js pages router) has `__NEXT_DATA__` with
 *   `props.pageProps.job.active` (false on a closed posting) and a JobPosting JSON-LD block.
 *   An unknown id redirects to `/404-page` with HTTP 200.
 */
import type { ScrapedJob } from '../types.ts';

export const SEARCH_URL = 'https://api.rooster.jobs/jobSearch/jobs/search';
export const jobUrl = (id: string | number): string => `https://rooster.jobs/jobs/${id}`;

const JOB_URL_RE = /^https?:\/\/(?:www\.)?rooster\.jobs\/jobs?\/(\d+)\/?(?:[?#].*)?$/i;

/** The posting id from a job URL (`/jobs/<id>` or `/job/<id>`), or null. */
export function externalIdFromUrl(url: string): string | null {
  return url.trim().match(JOB_URL_RE)?.[1] ?? null;
}

export function searchBody(page: number, limit: number): Record<string, unknown> {
  return { query: [], limit, page, filters: { country: 'Sri Lanka' } };
}

export interface RoosterItem {
  id: number | string;
  title?: string | null;
  description?: string | null;
  company_name?: string | null;
  subsidiary_company_name?: string | null;
  job_type?: string | null;
  location?: string | null;
  department?: string | null;
  created_at?: string | null;
  remote?: boolean | null;
  class?: string | null;
  subclass?: string | null;
  min_salary?: number | string | null;
  max_salary?: number | string | null;
  salary_frequency?: string | null;
  salary_currency?: string | null;
}

export interface SearchPage {
  count: number;
  items: RoosterItem[];
}

/** Parses one search answer; null when it is not the shape the front end reads (drift). */
export function parseSearch(text: string): SearchPage | null {
  let d: any;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  const body = d?.body;
  if (!body || !Array.isArray(body.data)) return null;
  const items = (body.data as unknown[]).filter(
    (x): x is RoosterItem => !!x && typeof x === 'object' && (typeof (x as any).id === 'number' || /^\d+$/.test(String((x as any).id))),
  );
  return { count: Number(body.count) || 0, items };
}

/** Sri Lanka–based: the location text names Sri Lanka (the API's own country filter is applied too). */
export function isSriLanka(item: RoosterItem): boolean {
  return /\bsri[-\s]?lanka\b/i.test(item.location ?? '');
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const money = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

/** "LKR 90,000–150,000 / month" from the structured fields; null without a currency and a figure. */
export function salaryText(item: RoosterItem): string | null {
  const cur = str(item.salary_currency);
  const lo = num(item.min_salary);
  const hi = num(item.max_salary);
  if (!cur || (lo === null && hi === null)) return null;
  const figure = lo !== null && hi !== null && lo !== hi ? `${money(lo)}–${money(hi)}` : money((hi ?? lo)!);
  const per = str(item.salary_frequency);
  return `${cur.toUpperCase()} ${figure}${per ? ` / ${per.toLowerCase()}` : ''}`;
}

/** One API item → a ScrapedJob, or null when it has no title. */
export function itemToJob(item: RoosterItem, now: Date): ScrapedJob | null {
  const title = str(item.title);
  if (!title) return null;
  const id = String(item.id);
  const url = jobUrl(id);
  const created = typeof item.created_at === 'string' ? item.created_at.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null : null;
  return {
    title,
    company: str(item.subsidiary_company_name) ?? str(item.company_name),
    location: str(item.location),
    category: str(item.class),
    salary_text: salaryText(item),
    description: typeof item.description === 'string' && item.description.trim() ? item.description : null,
    closing_date: null,
    // created_at has no zone in the API, so only its date is kept.
    posted_at: created,
    apply_method: 'portal',
    apply_url: url,
    is_image_ad: false,
    employment_type: str(item.job_type),
    remote: typeof item.remote === 'boolean' ? item.remote : null,
    country_code: 'LK',
    external_id: id,
    source_url: url,
    scraped_at: now.toISOString(),
  };
}

/** `job.active` from a job page's __NEXT_DATA__: true/false, or null when the page has no job. */
export function pageActive(html: string): boolean | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]);
    const job = d?.props?.pageProps?.job;
    return job && typeof job.active === 'boolean' ? job.active : null;
  } catch {
    return null;
  }
}
