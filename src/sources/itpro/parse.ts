/**
 * ITPro.lk parsing (verified against the live site on 15 Nov 2026).
 *
 * - Listing: https://itpro.lk/sitemap.xml lists every open job as /job/<id>/<slug>/ with a lastmod
 *   date (867 on 15 Nov 2026); https://itpro.lk/rss/all/ is the 25 newest, used if the sitemap fails.
 * - Detail: each job page carries a schema.org JobPosting with an `identifier` equal to the URL id.
 *   Applications go through ITPro's own form on the job page (`directApply: true`).
 * - validThrough is the board's own listing expiry, set to exactly 90 days after datePosted, not the
 *   employer's deadline (job 15785: validThrough 13 Feb 2027, ad text "Apply before: 30 November 2026").
 *   That default is not used as a closing date; the ad's stated date fills it instead.
 * - A removed job still answers 200 with the title "Job Unavailable | ITPro.lk".
 */
import { htmlToText } from '../../jobs/extract.ts';
import type { ScrapedJob } from '../types.ts';
import { daysBetween, findJobPosting, postingFields } from './jsonld.ts';
import { closingDateFromText } from './text.ts';

export const BASE = 'https://itpro.lk';
export const SITEMAP_URL = `${BASE}/sitemap.xml`;
export const RSS_URL = `${BASE}/rss/all/`;

export interface ListingEntry {
  external_id: string;
  url: string;
  lastmod: string | null;
}

const JOB_URL = /^https?:\/\/(?:www\.)?itpro\.lk\/jobs?\/(\d+)\/[^?#]*$/i;

/** The posting id in an ITPro job URL (/job/15785/slug/), else null. */
export function itproId(url: string): string | null {
  return url.trim().match(JOB_URL)?.[1] ?? null;
}

function byIdDesc(entries: Map<string, ListingEntry>): ListingEntry[] {
  return [...entries.values()].sort((a, b) => Number(b.external_id) - Number(a.external_id));
}

/** Job URLs from sitemap.xml, newest (highest id) first. Non-job pages are ignored. */
export function parseSitemap(xml: string): ListingEntry[] {
  const out = new Map<string, ListingEntry>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    const id = itproId(loc);
    if (!id || out.has(id)) continue;
    const lastmod = m[1].match(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
    out.set(id, { external_id: id, url: loc.replace(/^http:/, 'https:'), lastmod });
  }
  return byIdDesc(out);
}

/** Job URLs from the RSS feed, newest first. */
export function parseRss(xml: string): ListingEntry[] {
  const out = new Map<string, ListingEntry>();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const link = m[1].match(/<link>\s*([^<\s]+)\s*<\/link>/i)?.[1];
    const id = link ? itproId(link) : null;
    if (!link || !id || out.has(id)) continue;
    const pub = m[1].match(/<pubDate>([^<]+)<\/pubDate>/i)?.[1];
    const t = pub ? Date.parse(pub) : NaN;
    out.set(id, { external_id: id, url: link, lastmod: Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null });
  }
  return byIdDesc(out);
}

export function isUnavailable(html: string): boolean {
  return /<title>\s*Job Unavailable\b/i.test(html);
}

/** A detail page is what we expect when it has a JobPosting, or is ITPro's "Job Unavailable" page. */
export function detailLooksRight(html: string): boolean {
  return /"@type"\s*:\s*"JobPosting"/.test(html) || isUnavailable(html);
}

function sectionHtml(html: string): string | null {
  const m = html.match(/<section[^>]+id=["']job-description["'][^>]*>([\s\S]*?)<\/section>/i);
  return m ? m[1].replace(/<h2[^>]*visually-hidden[^>]*>[\s\S]*?<\/h2>/i, '').trim() || null : null;
}

/** A ScrapedJob from a job page, or null when the page has no JobPosting. */
export function parseDetail(html: string, jsonLd: unknown[], url: string, scrapedAt: string): ScrapedJob | null {
  const ld = findJobPosting(jsonLd);
  if (!ld) return null;
  const f = postingFields(ld);
  if (!f.title) return null;
  const id = itproId(url) ?? (typeof ld.identifier?.value === 'string' ? ld.identifier.value : null);
  if (!id) return null;

  // The board's 90-day default expiry is not the employer's closing date (see the header note).
  if (f.closing_date && f.posted_at && Math.abs(daysBetween(f.posted_at, f.closing_date) - 90) <= 1) f.closing_date = null;

  const description = sectionHtml(html) ?? f.description ?? null;
  if (!f.closing_date) f.closing_date = closingDateFromText(description);
  if (!f.location) {
    const la = html.match(/<span class="la"[^>]*>\s*([^<&]+?)\s*&bull;/i)?.[1];
    if (la) f.location = htmlToText(la).slice(0, 200) || null;
  }

  return {
    ...f,
    title: f.title,
    description,
    country_code: f.country_code ?? 'LK',
    apply_method: 'portal',
    apply_url: url,
    is_image_ad: false,
    external_id: id,
    source_url: url,
    scraped_at: scrapedAt,
  };
}

/** For recheck: 'closed' on the Unavailable page or a validThrough already past, 'alive' on a live posting. */
export function detailLiveness(html: string, jsonLd: unknown[], today: string): 'alive' | 'closed' | 'unknown' {
  if (isUnavailable(html)) return 'closed';
  const ld = findJobPosting(jsonLd);
  if (!ld) return 'unknown';
  const until = postingFields(ld).closing_date;
  if (until && until < today) return 'closed';
  return 'alive';
}
