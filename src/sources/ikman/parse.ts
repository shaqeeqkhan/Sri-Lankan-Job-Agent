/**
 * ikmanJOBS (ikman.lk) parsing. Pure functions, tested on fixtures.
 *
 * Verified 15 Nov 2026:
 * - Listing `https://ikman.lk/en/ads/sri-lanka/jobs?page=N` (25 ads a page plus featured/top ads,
 *   newest first: the default sort is `date_desc`, where a paid "bump" counts as new). The page
 *   embeds the whole result as `window.initialData = {…}` (serp.ads.data.ads / topAds /
 *   paginationData). About 10,300 job ads.
 * - Detail `https://ikman.lk/en/ad/<slug>` embeds `window.initialData.adDetail.data.ad` (properties:
 *   Employer, Job type, Salary per month, Required education, experience, Application deadline;
 *   job.apply_via: phone numbers and/or apply on ikman) and a schema.org JobPosting JSON-LD block.
 * - A missing ad answers HTTP 410 with adDetail.type = "Failure".
 * - The sitemaps are raw .xml.gz files (content-type application/gzip), which the text-only
 *   HttpClient cannot read, so the listing pages are the index.
 * The posting id used for identity is the ad slug (the URL's last segment), as PRD §7.2 says.
 */
import type { ScrapedJob } from '../types.ts';

export const BASE = 'https://ikman.lk';
export const LISTING_URL = `${BASE}/en/ads/sri-lanka/jobs`;

export function listingPageUrl(page: number, base = LISTING_URL): string {
  return page <= 1 ? base : `${base}${base.includes('?') ? '&' : '?'}page=${page}`;
}

export function adUrl(slug: string): string {
  return `${BASE}/en/ad/${slug}`;
}

/** The ad slug from an ad URL in any language (`/en/ad/<slug>`, `/si/ad/<slug>`). */
export function externalIdFromUrl(url: string): string | null {
  const m = url.match(/ikman\.lk\/(?:[a-z]{2}\/)?ad\/([a-z0-9][a-z0-9-]*)/i);
  return m ? m[1].toLowerCase() : null;
}

/** `window.initialData = {...}` from an ikman page, or null. */
export function initialData(html: string): Record<string, any> | null {
  const marker = html.indexOf('window.initialData');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;
  // Walk the object literal, honouring strings, to find its end.
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const isListingPage = (html: string) => html.includes('window.initialData') && html.includes('"serp"');
export const isAdPage = (html: string) => html.includes('window.initialData') && html.includes('"adDetail"');

export interface ListingAd {
  slug: string;
  id: string | null;
  title: string;
  location: string | null;
  category: string | null;
  company: string | null;
  salary: string | null;
  deadline: string | null;
  featured: boolean;
}

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

function isoDay(v: unknown): string | null {
  const s = clean(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Ads on one listing page (regular ads then top ads, deduped by slug), plus the reported total. */
export function parseListing(html: string): { ads: ListingAd[]; total: number | null; ok: boolean } {
  const d = initialData(html);
  const data = d?.serp?.ads?.data;
  if (!data || !Array.isArray(data.ads)) return { ads: [], total: null, ok: false };
  const out = new Map<string, ListingAd>();
  for (const a of [...data.ads, ...(Array.isArray(data.topAds) ? data.topAds : [])]) {
    const slug = clean(a?.slug)?.toLowerCase();
    const title = clean(a?.title);
    if (!slug || !title || out.has(slug)) continue;
    out.set(slug, {
      slug,
      id: clean(a.id),
      title,
      location: clean(a.location),
      category: clean(a.category?.name),
      company: clean(a.details),
      salary: clean(a.price),
      deadline: isoDay(a.isJobAd?.deadline),
      featured: a.isFeaturedAd === true || a.isTopAd === true,
    });
  }
  const total = typeof data.paginationData?.total === 'number' ? data.paginationData.total : null;
  return { ads: [...out.values()], total, ok: true };
}

interface Prop {
  key?: string;
  label?: string;
  value?: string;
}

function jobPosting(jsonLd: unknown[]): Record<string, any> | null {
  for (const x of jsonLd) {
    const list = Array.isArray(x) ? x : [x];
    for (const o of list) if (o && typeof o === 'object' && (o as any)['@type'] === 'JobPosting') return o as Record<string, any>;
  }
  return null;
}

const fmt = (n: number) => n.toLocaleString('en-US');

function ldSalary(ld: Record<string, any> | null): string | null {
  const v = ld?.baseSalary?.value;
  const cur = clean(ld?.baseSalary?.currency);
  const min = Number(v?.minValue);
  const max = Number(v?.maxValue);
  if (!cur || !(min > 0)) return null;
  const hi = max > min ? max : min;
  const unit = clean(v?.unitText)?.toLowerCase();
  return `${cur} ${fmt(min)}${hi !== min ? `–${fmt(hi)}` : ''}${unit ? ` per ${unit}` : ''}`;
}

/** Below this much description text an ad with images is read from its images (vision path). */
export const IMAGE_AD_MAX_TEXT = 40;

/** Only an explicit phrase counts ("Online Marketing Executive" is not a remote job). */
const REMOTE_RE = /\b(work from home|wfh|remote)\b/i;

/** Liveness inputs from an ad page. */
export function adState(html: string): { found: boolean; status: string | null; deadline: string | null } {
  const ad = initialData(html)?.adDetail?.data?.ad;
  if (!ad) return { found: false, status: null, deadline: null };
  const props: Prop[] = Array.isArray(ad.properties) ? ad.properties : [];
  return {
    found: true,
    status: clean(ad.status),
    deadline: isoDay(ad.job?.deadline) ?? isoDay(props.find((p) => p.key === 'deadline')?.value),
  };
}

/**
 * Map an ad page to a ScrapedJob. Structured values first: initialData properties and the
 * JobPosting JSON-LD; the listing row only fills what the page left null.
 */
export function mapAd(
  html: string,
  jsonLd: unknown[],
  opts: { slug: string; listing?: ListingAd | null; scrapedAt: string },
): ScrapedJob | null {
  const ad = initialData(html)?.adDetail?.data?.ad;
  if (!ad) return null;
  const ld = jobPosting(jsonLd);
  const props: Prop[] = Array.isArray(ad.properties) ? ad.properties : [];
  const prop = (key: string) => clean(props.find((p) => p.key === key)?.value);
  const li = opts.listing ?? null;

  const title = clean(ad.title) ?? clean(ld?.title) ?? li?.title ?? null;
  if (!title) return null;
  const company = prop('company_name') ?? clean(ld?.hiringOrganization?.name) ?? li?.company ?? null;

  const place = clean(ad.location?.name);
  const area = clean(ad.area?.name) ?? clean(ad.location?.parent?.name);
  const location = place && area && place !== area ? `${place}, ${area}` : place ?? area ?? li?.location ?? null;

  const salaryProp = props.find((p) => p.key === 'salary');
  const salaryVal = clean(salaryProp?.value);
  const salary = salaryVal
    ? /month/i.test(salaryProp?.label ?? '') && !/month/i.test(salaryVal) ? `${salaryVal} per month` : salaryVal
    : ldSalary(ld) ?? li?.salary ?? null;

  const deadline = isoDay(ad.job?.deadline) ?? prop('deadline') ?? isoDay(ld?.validThrough) ?? li?.deadline ?? null;

  const descText: string = typeof ad.description === 'string' ? ad.description.trim() : typeof ld?.description === 'string' ? ld.description.trim() : '';
  const images: string[] = (Array.isArray(ad.images?.meta) ? ad.images.meta : [])
    .map((m: any) => clean(m?.src))
    .filter((s: string | null): s is string => !!s && /^https?:\/\//.test(s));
  const isImage = images.length > 0 && descText.replace(/\s+/g, ' ').length < IMAGE_AD_MAX_TEXT;

  const extras: string[] = [];
  const role = prop('item_type');
  if (role) extras.push(`Role: ${role}`);
  const edu = prop('min_qualification');
  if (edu) extras.push(`Required education: ${edu}`);
  const exp = prop('experience');
  if (exp) extras.push(`Required work experience: ${exp} year${exp === '1' ? '' : 's'}`);
  const web = prop('company_website');
  if (web) extras.push(`Company website: ${web}`);
  if (isImage) for (const src of images) extras.push(`Advert image: ${src}`);
  const description = [descText, extras.join('\n')].filter(Boolean).join('\n\n') || null;

  const via = ad.job?.apply_via ?? {};
  const phone = clean(via.phone_number) ?? (Array.isArray(via.phone_numbers) ? clean(via.phone_numbers[0]) : null);
  const email = clean(via.email);
  const onSite = via.dashboard === true;
  const url = adUrl(opts.slug);
  const apply_method = email ? 'email' : onSite ? 'portal' : phone ? 'phone' : null;
  const instructions: string[] = [];
  if (onSite) instructions.push(`Apply on ikman (sign in with your own account)${via.mandate_resume ? '; a CV is required' : ''}.`);
  if (phone) instructions.push(`Call ${phone}.`);

  const remote = REMOTE_RE.test(title) || REMOTE_RE.test(place ?? '') ? true : null;

  return {
    title,
    company,
    location,
    category: clean(ad.category?.name) ?? li?.category ?? null,
    salary_text: salary,
    description,
    closing_date: deadline,
    apply_method,
    apply_url: onSite ? url : null,
    apply_email: email,
    apply_phone: phone,
    apply_instructions: instructions.length ? instructions.join(' ') : null,
    is_image_ad: isImage,
    posted_at: clean(ad.adDate) ?? clean(ld?.datePosted),
    external_id: opts.slug,
    country_code: 'LK',
    remote,
    employment_type: prop('employment') ?? clean(ld?.employmentType),
    scraped_at: opts.scrapedAt,
    source_url: url,
  };
}
