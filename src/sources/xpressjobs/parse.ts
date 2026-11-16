/**
 * XpressJobs (xpress.jobs) parsing. Pure functions, tested on fixtures.
 *
 * Verified 15 Nov 2026: the site is a React SPA (job pages are an empty shell, no JSON-LD in the
 * served HTML). Its own front end reads a public JSON API:
 *   GET https://xpress.jobs/api/jobs/searchJobs?page=N&pageSize=M&sortBy=SortedCreateDate%20DESC&…
 *       → array of list rows; `recordCount` on each row is the total (≈4,200 open jobs)
 *   GET https://xpress.jobs/api/jobs/publishedJob?jobId=<id>
 *       → one job in full (200), or 204 with an empty body when the id is not a published job
 * and `https://xpress.jobs/sitemap.xml` (3 MB, one request) lists every open job as
 * `/jobs/view/<jobId>/<slug>` with a `<lastmod>` date.
 * The field mapping follows the site's own JSON-LD builder in its JS bundle (salary is LKR/month,
 * "Any" / "-" mean no value, a location containing "Foreign Job" is not in Sri Lanka).
 */
import type { ScrapedJob } from '../types.ts';

export const BASE = 'https://xpress.jobs';
export const SITEMAP_URL = `${BASE}/sitemap.xml`;
export const API_BASE = `${BASE}/api/`;

export function detailApiUrl(jobId: string, apiBase = API_BASE): string {
  return `${apiBase}jobs/publishedJob?jobId=${encodeURIComponent(jobId)}`;
}

export function searchApiUrl(page: number, pageSize: number, apiBase = API_BASE): string {
  const q = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    keyword: '',
    locations: '',
    sectors: '',
    jobTypes: '',
    careerLevels: '',
    sortBy: 'SortedCreateDate DESC',
    byCVLess: 'false',
    byWalkIn: 'false',
  });
  return `${apiBase}jobs/searchJobs?${q.toString()}`;
}

const VIEW_RE = /\/jobs\/view\/(\d+)(?:\/|$|\?|#)/;

/** The posting id from a job URL (`https://xpress.jobs/jobs/view/352788/slug` → "352788"). */
export function externalIdFromUrl(url: string): string | null {
  const m = url.match(VIEW_RE);
  return m ? m[1] : null;
}

export interface SitemapEntry {
  id: string;
  url: string;
  lastmod: string | null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Job entries in the sitemap, newest (highest id) first. Non-job URLs are ignored. */
export function parseSitemap(xml: string): SitemapEntry[] {
  const out = new Map<string, SitemapEntry>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (!loc) continue;
    const url = decodeXml(loc);
    const id = externalIdFromUrl(url);
    if (!id || out.has(id)) continue;
    const lastmod = m[1].match(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    out.set(id, { id, url, lastmod });
  }
  return [...out.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

/** True when the body looks like the site's sitemap (used to tell drift from an empty board). */
export function isSitemap(xml: string): boolean {
  return /<urlset[\s>]/.test(xml) && xml.includes('xpress.jobs');
}

export interface XpListRow {
  jobId?: number | string;
  jobTitle?: string | null;
  organizationName?: string | null;
  recordCount?: number;
  [k: string]: unknown;
}

export interface XpJobItem {
  jobId?: number;
  jobTitle?: string | null;
  organizationName?: string | null;
  overview?: string | null;
  expiryDateOnWebsite?: string | null;
  jobType?: string | null;
  locations?: string | null;
  remote?: boolean | null;
  archived?: boolean | null;
  isGovernmentJob?: boolean | null;
}

export interface XpDetail {
  jobId?: number | string;
  jobTitle?: string | null;
  education?: string | null;
  experience?: string | null;
  minSalary?: string | number | null;
  maxSalary?: string | number | null;
  salaryRange?: string | null;
  jobHasImage?: boolean | null;
  jobInfo?: string | null;
  jobImageUri?: string | null;
  benefits?: string | null;
  isRedirected?: boolean | null;
  redirectingUrl?: string | null;
  jobItem?: XpJobItem | null;
  sectors?: { sectorName?: string | null }[] | null;
  organization?: { organizationName?: string | null } | null;
  createdDate?: string | null;
}

/** A publishedJob body that has the fields the mapping needs; anything else is drift. */
export function isDetail(v: unknown): v is XpDetail {
  if (!v || typeof v !== 'object') return false;
  const d = v as XpDetail;
  return d.jobId != null && typeof d.jobTitle === 'string' && !!d.jobItem && typeof d.jobItem === 'object';
}

/** "Any", "-", "" and null mean no value (the site's own rule). */
function val(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' || s === '-' || s.toLowerCase() === 'any' ? null : s;
}

function num(v: unknown): number | null {
  const s = val(v);
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Structured salary: LKR per month from minSalary/maxSalary, else the site's salaryRange text. */
export function salaryText(d: XpDetail): string | null {
  const min = num(d.minSalary);
  if (min !== null) {
    const max = num(d.maxSalary);
    const hi = max !== null && max > min ? max : min;
    return `LKR ${fmt(min)}${hi !== min ? `–${fmt(hi)}` : ''} per month`;
  }
  return val(d.salaryRange);
}

/** "Colombo, Western Province; Kandy, Central Province" → parts, each trimmed. */
export function locationParts(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(';')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An ad whose text is this short and that has an image is read from the image (vision path). */
export const IMAGE_AD_MAX_TEXT = 200;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The public page for a job, built the way the site builds it. */
export function viewUrl(id: string, title: string | null | undefined, company: string | null | undefined): string {
  const slug = slugify(`${title ?? ''}-${company ?? ''}`);
  return `${BASE}/jobs/view/${id}${slug ? `/${slug}` : ''}`;
}

/** Map one publishedJob body to a ScrapedJob. Returns null when it has no usable title. */
export function mapDetail(d: XpDetail, opts: { sourceUrl?: string | null; scrapedAt: string }): ScrapedJob | null {
  const id = String(d.jobId ?? '').trim();
  const item = d.jobItem ?? {};
  const title = val(d.jobTitle) ?? val(item.jobTitle);
  if (!id || !title) return null;
  const company = val(d.organization?.organizationName) ?? val(item.organizationName);
  const parts = locationParts(item.locations);
  const domestic = parts.filter((p) => !/foreign job/i.test(p));
  const remote = item.remote === true || parts.some((p) => /remote|work from home/i.test(p));

  const info = d.jobInfo ?? '';
  const text = stripTags(info);
  const image = d.jobHasImage ? val(d.jobImageUri) ?? `${API_BASE}vacancy/getJobDescriptionImage?jobId=${id}` : null;
  const extras: string[] = [];
  if (val(d.education)) extras.push(`<p>Education: ${val(d.education)}</p>`);
  if (val(d.experience)) extras.push(`<p>Experience: ${val(d.experience)}</p>`);
  if (val(d.benefits)) extras.push(`<p>Benefits: ${val(d.benefits)}</p>`);
  if (image) extras.push(`<p>Advert image: <a href="${image}">${image}</a></p>`);
  const description = [info || (val(item.overview) ? `<p>${val(item.overview)}</p>` : ''), ...extras].filter(Boolean).join('\n') || null;

  const redirect = d.isRedirected ? val(d.redirectingUrl) : null;
  const sourceUrl = opts.sourceUrl ?? viewUrl(id, title, company);
  const closing = val(item.expiryDateOnWebsite)?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;

  return {
    title,
    company,
    location: domestic.length ? domestic.join('; ').slice(0, 200) : parts.join('; ').slice(0, 200) || null,
    category: val(d.sectors?.[0]?.sectorName),
    salary_text: salaryText(d),
    description,
    closing_date: closing,
    // Not redirected: the person applies on XpressJobs itself (signed in, in their own browser).
    apply_method: redirect ? null : 'portal',
    apply_url: redirect && /^https?:\/\//i.test(redirect) ? redirect : sourceUrl,
    apply_instructions: redirect ? null : 'Apply on XpressJobs (sign in with your own account).',
    is_image_ad: image !== null && text.length < IMAGE_AD_MAX_TEXT,
    posted_at: val(d.createdDate),
    external_id: id,
    country_code: parts.length > 0 && domestic.length === 0 ? null : 'LK',
    remote,
    employment_type: val(item.jobType),
    scraped_at: opts.scrapedAt,
    source_url: sourceUrl,
  };
}

/** Liveness from a publishedJob body: archived or a passed expiry is closed. */
export function detailLiveness(d: XpDetail, today: string): 'alive' | 'closed' {
  if (d.jobItem?.archived === true) return 'closed';
  const closing = val(d.jobItem?.expiryDateOnWebsite)?.slice(0, 10);
  if (closing && /^\d{4}-\d{2}-\d{2}$/.test(closing) && closing < today) return 'closed';
  return 'alive';
}

/** List rows from searchJobs (fallback listing when the sitemap is unavailable). */
export function parseSearchPage(body: unknown): { ids: string[]; total: number | null } {
  if (!Array.isArray(body)) return { ids: [], total: null };
  const ids: string[] = [];
  let total: number | null = null;
  for (const r of body as XpListRow[]) {
    if (r?.jobId == null) continue;
    ids.push(String(r.jobId));
    if (typeof r.recordCount === 'number' && r.recordCount > 0) total = r.recordCount;
  }
  return { ids, total };
}
