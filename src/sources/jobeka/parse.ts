/**
 * JobEka.lk parsing (pure, fixture-tested).
 *
 * Verified 2026-11-15 against the live site:
 * - The sitemaps are not usable: `jobs1-sitemap.xml` answers HTTP 500, `jobs2-sitemap.xml` is empty,
 *   and the 25 per-district sitemaps list mostly 2023–2025 postings.
 * - `https://jobeka.lk/jobs?page=N` lists 10 postings per page, newest (highest id) first, expired
 *   ones included (~1,000 pages). Each card (`.job-list-item`) has the job link
 *   `/jobs/<Title-Slug>-<id>`, title, company, "District > Town" and the application deadline.
 *   A "Featured jobs" block repeats a few cards without a deadline.
 * - A job page has schema.org `JobPosting` JSON-LD (title with " in <town>" appended, HTML
 *   description, datePosted, validThrough, employmentType, company, address), a "Job overview" box
 *   (Published on, Application deadline, Contact number, Salary(LKR), Employment Type), an Apply
 *   button to `https://jobeka.lk/apply-now?jobID=<id>`, and on a closed posting the marker
 *   "This job is expired". An unknown id redirects to /browse with HTTP 200 (soft 404).
 * - The slug is ignored: `/jobs/x-<id>` serves the same posting.
 */
import * as cheerio from 'cheerio';
import type { ScrapedJob } from '../types.ts';

export const HOST = 'https://jobeka.lk';
export const listingUrl = (page: number): string => (page <= 1 ? `${HOST}/jobs` : `${HOST}/jobs?page=${page}`);

const JOB_URL_RE = /^(?:https?:\/\/(?:www\.)?jobeka\.lk)?\/jobs\/[^?#]*?-(\d+)\/?(?:[?#].*)?$/i;

/** The posting id from a job URL (`/jobs/<slug>-<id>`), or null. */
export function externalIdFromUrl(url: string): string | null {
  let u = url.trim();
  try {
    u = decodeURI(u);
  } catch {
    // keep as is
  }
  return u.match(JOB_URL_RE)?.[1] ?? null;
}

export interface ListingCard {
  url: string;
  external_id: string;
  title: string | null;
  company: string | null;
  place: string | null;
  /** Application deadline shown on the card (YYYY-MM-DD), null on featured repeats. */
  deadline: string | null;
}

const clean = (s: string | undefined | null): string | null => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v ? v : null;
};

/** Cards on one /jobs listing page, in page order, one per id (the dated copy wins). */
export function parseListing(html: string): ListingCard[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, ListingCard>();
  $('.job-list-item a[href*="/jobs/"]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const id = externalIdFromUrl(href);
    if (!id) return;
    const url = new URL(href, HOST).toString();
    const card: ListingCard = {
      url,
      external_id: id,
      title: clean($(a).find('h6').first().text()),
      company: clean($(a).find('strong').first().text()),
      place: clean($(a).find('.fa-map-marker').first().parent().text()),
      deadline: clean($(a).find('.fa-clock-o').first().parent().text())?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
    };
    const prev = byId.get(id);
    if (!prev || (!prev.deadline && card.deadline)) byId.set(id, card);
  });
  return [...byId.values()];
}

export function isListingPage(html: string): boolean {
  return html.includes('job-list-item');
}

// ---------------------------------------------------------------- detail

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

export function isoDay(v: unknown): string | null {
  const m = typeof v === 'string' ? v.trim().match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return m ? m[1] : null;
}
/** Today in Sri Lanka (UTC+05:30), as YYYY-MM-DD. */
export function todayLk(now: Date): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** "Colombo > Homagama" → "Homagama, Colombo"; "Colombo > Colombo" → "Colombo". */
export function placeText(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.split('>').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length) return null;
  const [district, town] = parts;
  if (!town || town.toLowerCase() === district.toLowerCase()) return district;
  return `${town}, ${district}`;
}

/**
 * The "Salary(LKR):" value as written; "Unspecified" is null. The currency is NOT added: the field
 * is always labelled LKR, but foreign postings type their own currency into it (an Ajman job shows
 * "3000 - 6000"), so the label cannot be trusted (PRD rule 11).
 */
export function salaryText(raw: string | null): string | null {
  const v = clean(raw);
  if (!v || /^(unspecified|not specified|n\/?a|-|0)$/i.test(v)) return null;
  if (/^negotiable$/i.test(v)) return 'Negotiable';
  return v;
}

function overview($: cheerio.CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $('.job-overview li').each((_, li) => {
    const label = clean($(li).find('strong, span').first().text());
    if (!label) return;
    const all = clean($(li).text()) ?? '';
    const value = clean(all.slice(all.indexOf(label) + label.length).replace(/^[:\s]+/, ''));
    if (value) out[label.replace(/[:\s]+$/, '').toLowerCase()] = value;
  });
  return out;
}

export interface JobekaDetail {
  job: ScrapedJob | null;
  expired: boolean;
}

export function parseDetail(html: string, jsonLd: unknown[], url: string, now: Date): JobekaDetail {
  const id = externalIdFromUrl(url);
  const ld = findJobPosting(jsonLd);
  const $ = cheerio.load(html);
  const expired = /this job is expired/i.test($('.job-expired-lable').text()) || />[^<]*this job is expired\s*</i.test(html);
  if (!id || !ld) return { job: null, expired };

  const ov = overview($);
  const title = clean($('h1.title').first().text()) ?? clean(String(ld.title ?? ''));
  if (!title) return { job: null, expired };
  const addr = (Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation)?.address ?? {};
  const place = placeText(clean($('.job-platform .fa-map-marker').first().parent().text()));
  const phone = clean(ov['contact number'])?.match(/^\+?[\d\s-]{9,15}$/) ? clean(ov['contact number']) : null;
  const applyHref = $('a.applynow-btn').first().attr('href');
  const apply_url = applyHref ? new URL(applyHref, HOST).toString() : null;
  const description = typeof ld.description === 'string' && ld.description.trim() ? ld.description : clean($('#jobs-search').html());
  const descText = cheerio.load(description ?? '').text().replace(/\s+/g, ' ').trim();
  const hasImage = $('#jobs-search img').length > 0 || /<img/i.test(description ?? '');
  const salaryKey = Object.keys(ov).find((k) => k.startsWith('salary'));
  const cc = typeof addr.addressCountry === 'string' && /^[A-Z]{2}$/.test(addr.addressCountry) ? addr.addressCountry : 'LK';

  const job: ScrapedJob = {
    title,
    company: clean(ld.hiringOrganization?.name) ?? clean($('.job-platform .profile-name').first().text()),
    location: place ?? clean(addr.addressLocality),
    salary_text: salaryKey ? salaryText(ov[salaryKey]) : null,
    description,
    closing_date: isoDay(ld.validThrough) ?? isoDay(ov['application deadline']),
    posted_at: isoDay(ld.datePosted) ?? isoDay(ov['published on']),
    apply_method: apply_url ? 'portal' : phone ? 'phone' : null,
    apply_url,
    apply_phone: phone,
    is_image_ad: hasImage && descText.length < 200,
    employment_type: clean(typeof ld.employmentType === 'string' ? ld.employmentType : Array.isArray(ld.employmentType) ? ld.employmentType[0] : ov['employment type']),
    country_code: cc,
    external_id: id,
    source_url: url,
    scraped_at: now.toISOString(),
  };
  return { job, expired };
}

export function looksLikeJobPage(html: string): boolean {
  return html.includes('JobPosting');
}
