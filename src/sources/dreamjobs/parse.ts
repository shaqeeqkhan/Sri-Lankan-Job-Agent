/**
 * dreamjobs.lk parsing (verified against the live site on 15 Nov 2026).
 *
 * - Listing: https://dreamjobs.lk/jobs ("Browse Jobs") lists every OPEN job, grouped by industry,
 *   each with a "<n> Jobs" count. The home page's paginated list also carries long-expired ads, so it
 *   is not used. When an industry's count is larger than the links shown, its /industry/<slug> page
 *   is read too.
 * - The posting id in the URL is a slug (/jobs/sales-officers-freshers); reposts get -2, -3… The site's
 *   numeric id only appears on the detail page (/jobs/32645/apply), so the slug is the external id.
 * - Detail: a JobPosting JSON-LD block (title, employer, datePosted, validThrough, locality) whose
 *   description is boilerplate ("Hiring now for … Apply today."). The real ad is the page's
 *   .job-summary / .job-description HTML and, very often, an image in .job-image.
 * - Applications go through the site's own form at /jobs/<numeric id>/apply.
 * - An expired job keeps its page but loses the JSON-LD block, the Apply button and the closing date;
 *   an unknown slug is a 404.
 */
import { decodeEntities, htmlToText } from '../../jobs/extract.ts';
import type { ScrapedJob } from '../types.ts';
import { findJobPosting, postingFields, str } from '../itpro/jsonld.ts';
import { closingDateFromText } from '../itpro/text.ts';

export const BASE = 'https://dreamjobs.lk';
export const LISTING_URL = `${BASE}/jobs`;

export interface ListingEntry {
  external_id: string;
  url: string;
  title: string | null;
}
export interface Industry {
  url: string;
  count: number;
  shown: number;
}

const RESERVED = new Set(['search', 'closing-soon', 'apply', 'print', 'shortlist']);
const JOB_HREF = /href=["'](?:https?:\/\/(?:www\.)?dreamjobs\.lk)?\/jobs\/([a-z0-9][a-z0-9-]*)["']/gi;

/** The slug in a dreamjobs job URL, else null. */
export function dreamjobsSlug(url: string): string | null {
  const m = url.match(/^https?:\/\/(?:www\.)?dreamjobs\.lk\/jobs\/([a-z0-9][a-z0-9-]*)\/?(?:[?#].*)?$/i);
  return m && !RESERVED.has(m[1].toLowerCase()) && !/^\d+$/.test(m[1]) ? m[1].toLowerCase() : null;
}

/** Every job link on a listing page, in page order, with the title shown next to it. */
export function parseJobLinks(html: string): ListingEntry[] {
  const out = new Map<string, ListingEntry>();
  for (const m of html.matchAll(JOB_HREF)) {
    const slug = m[1].toLowerCase();
    if (RESERVED.has(slug) || /^\d+$/.test(slug) || out.has(slug)) continue;
    const after = html.slice(m.index, m.index + 600);
    const t = after.match(/class=["'](?:job-title|item-heading)["'][^>]*>([^<]+)</i)?.[1];
    out.set(slug, { external_id: slug, url: `${BASE}/jobs/${slug}`, title: t ? decodeEntities(t).trim() || null : null });
  }
  return [...out.values()];
}

/** The industries on /jobs with their job counts, to spot an industry whose list is cut short. */
export function parseIndustries(html: string): Industry[] {
  const out: Industry[] = [];
  const parts = html.split(/<div class=["']category list-item["']>/i).slice(1);
  for (const part of parts) {
    const href = part.match(/href=["']((?:https?:\/\/(?:www\.)?dreamjobs\.lk)?\/industry\/[a-z0-9-]+)["']/i)?.[1];
    const count = Number(part.match(/job-count["'][^>]*>\s*(\d+)\s+Jobs?/i)?.[1] ?? NaN);
    if (!href || !Number.isFinite(count)) continue;
    out.push({ url: href.startsWith('http') ? href : `${BASE}${href}`, count, shown: parseJobLinks(part).length });
  }
  return out;
}

export function isBrowsePage(html: string): boolean {
  return /id=["']categories-page["']/.test(html) || /<h1>\s*Browse Jobs\s*<\/h1>/i.test(html);
}

export function detailLooksRight(html: string): boolean {
  return /id=["']job-page["']/.test(html) && /<h1[\s>]/i.test(html);
}

function between(html: string, re: RegExp): string | null {
  return html.match(re)?.[1]?.trim() || null;
}

function contentHtml(html: string): { body: string | null; image: string | null } {
  const content = between(html, /<div class=["']job-content["'][^>]*>([\s\S]*?)<div class=["']secondary-actions["']/i) ?? '';
  const image = between(content, /<div class=["']job-image["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i);
  const pieces: string[] = [];
  for (const m of content.matchAll(/<div class=["'](?:job-summary|job-description)["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    if (htmlToText(m[1]).trim()) pieces.push(m[1].trim());
  }
  return { body: pieces.length ? pieces.join('\n') : null, image: image && /^https?:\/\//i.test(image) ? image : null };
}

/** A ScrapedJob from a live job page, or null when the page is not a live posting. */
export function parseDetail(html: string, jsonLd: unknown[], url: string, scrapedAt: string): ScrapedJob | null {
  const slug = dreamjobsSlug(url);
  if (!slug) return null;
  const ld = findJobPosting(jsonLd);
  const applyId = between(html, /href=["'](?:https?:\/\/(?:www\.)?dreamjobs\.lk)?\/jobs\/(\d+)\/apply["']/i);
  if (!ld && !applyId) return null; // expired: no posting data and no Apply button
  const f = ld ? postingFields(ld) : {};

  const h1 = between(html, /<div class=["']details[^"']*["'][^>]*>\s*<h1>([\s\S]*?)<\/h1>/i);
  const title = f.title ?? (h1 ? str(htmlToText(h1)) : null);
  if (!title) return null;
  const employer = between(html, /<div class=["']employer["'][^>]*>\s*<a[^>]*>([^<]+)<\/a>/i);
  const industry = between(html, /<ol class=["']breadcrumb["'][\s\S]*?<a href=["'][^"']*\/industry\/[^"']*["']>([^<]+)<\/a>/i);
  const closeText = between(html, /<div class=["']closing-date["'][^>]*>([^<]+)<\/div>/i);

  const { body, image } = contentHtml(html);
  const boilerplate = !f.description || /^\s*(?:<div>)?\s*Hiring now for\b[\s\S]{0,400}Apply today\.?\s*(?:<\/div>)?\s*$/i.test(f.description);
  const parts: string[] = [];
  if (body) parts.push(body);
  else if (!boilerplate && f.description) parts.push(f.description);
  if (image) parts.push(`<p>Advertisement image: ${image}</p>`);
  const textLen = body ? htmlToText(body).length : 0;

  return {
    ...f,
    title,
    company: f.company ?? (employer ? str(employer, 200) : null),
    category: f.category ?? (industry ? str(industry, 100) : null),
    description: parts.length ? parts.join('\n') : null,
    closing_date: f.closing_date ?? closingDateFromText(closeText),
    country_code: f.country_code ?? 'LK',
    apply_method: 'portal',
    apply_url: applyId ? `${BASE}/jobs/${applyId}/apply` : url,
    // The ad is an image when the image carries it: no text beyond a line or two.
    is_image_ad: Boolean(image) && textLen < 200,
    external_id: slug,
    source_url: url,
    scraped_at: scrapedAt,
  };
}

/** For recheck: 'closed' when the page shows no live posting or its closing date is past. */
export function detailLiveness(html: string, jsonLd: unknown[], url: string, today: string): 'alive' | 'closed' | 'unknown' {
  if (!detailLooksRight(html)) return 'unknown';
  const job = parseDetail(html, jsonLd, url, '');
  if (!job) return 'closed';
  if (job.closing_date && job.closing_date < today) return 'closed';
  return 'alive';
}
