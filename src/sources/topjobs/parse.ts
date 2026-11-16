/**
 * topjobs.lk parsing. Pure functions, tested on fixtures.
 *
 * Verified 15 Nov 2026 with plain HTTP (no browser needed, no human check seen):
 * - Listing `https://www.topjobs.lk/applicant/vacancybyfunctionalarea.jsp?FA=AV` ("All Vacancies")
 *   is one server-rendered table of about 1,000 rows a page (2.2 MB), newest job code first, with
 *   `pageNo=N` links (about 4,900 open jobs in 5 pages). Each row:
 *   `<tr id="trN" onclick="createAlert('N','<agent code>','<job code>','<employer code>',…)">` and
 *   cells: ref no, title (<h2>) + employer (<h1>), short text, opening date, closing date, town.
 * - Detail `https://www.topjobs.lk/employer/JobAdvertismentServlet?ac=<ac>&jc=<jc>&ec=<ec>`:
 *   #employer, #adview-job-location, #endDate (dd/mm/yyyy), #jobRefNum, .lbl_fulltime labels
 *   (Full Time / Permanent / Onsite), #position, #remark (the advert; nearly always one <img>),
 *   and the apply-by-email address in the readonly input #txtAVECompanyEmail (empty when the ad
 *   is applied for through a topjobs account only).
 * - A bad or old link redirects to /util/errorPage.jsp?errCode=601 with HTTP 200 (no 404).
 * The posting id is the job code `jc` (zero-padded, e.g. "0001571429").
 */
import { parseDate } from '../../jobs/normalize.ts';
import type { ScrapedJob } from '../types.ts';

export const BASE = 'https://www.topjobs.lk';
export const LISTING_URL = `${BASE}/applicant/vacancybyfunctionalarea.jsp?FA=AV`;

export function adUrl(ac: string, jc: string, ec: string): string {
  return `${BASE}/employer/JobAdvertismentServlet?ac=${encodeURIComponent(ac)}&jc=${encodeURIComponent(jc)}&ec=${encodeURIComponent(ec)}`;
}

/** The job code from an ad URL (`…JobAdvertismentServlet?…&jc=0001571429&…` → "0001571429"). */
export function externalIdFromUrl(url: string): string | null {
  const m = url.match(/[?&](?:jc|js|jon)=(\d{5,})/i);
  return m ? m[1] : null;
}

export function decode(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function text(html: string | null | undefined): string | null {
  if (!html) return null;
  const s = decode(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return s || null;
}

export const isListingPage = (html: string) => html.includes('createAlert(') || html.includes('hdnTotalJobs');
export const isAdPage = (html: string) => /id=["']position["']/.test(html) && /id=["']jsCode["']/.test(html);
export const isErrorPage = (html: string, finalUrl = '') => /errorPage\.jsp/i.test(finalUrl) || (/System Error/.test(html) && /invalid parameters/i.test(html));

export interface ListingRow {
  jc: string;
  ac: string;
  ec: string;
  ref: string | null;
  title: string;
  company: string | null;
  summary: string | null;
  opening_date: string | null;
  closing_date: string | null;
  town: string | null;
}

/** "Sun Nov 15 2026" → "2026-11-15". */
function rowDate(s: string | null): string | null {
  if (!s) return null;
  return parseDate(s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+/i, ''));
}

/** "Please refer the vacancy" and friends are not a summary. */
const NO_SUMMARY = /^pl\w*\s+refer\b[^.]{0,40}\.?$/i;

export function parseListing(html: string): { rows: ListingRow[]; total: number | null; nextUrl: string | null } {
  const rows = new Map<string, ListingRow>();
  for (const m of html.matchAll(/<tr\b[^>]*\bonclick="createAlert\('(\d+)'\s*,\s*'([^']*)'\s*,\s*'(\d+)'\s*,\s*'([^']*)'[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const [, , ac, jc, ec, body0] = m;
    if (rows.has(jc)) continue;
    const body = body0.replace(/<!--[\s\S]*?-->/g, '');
    const title = text(body.match(/<h2>([\s\S]*?)<\/h2>/)?.[1]);
    if (!title) continue;
    const cells = [...body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    // # | ref | position+employer | summary | opening | closing | town
    const summary = text(cells[3]);
    rows.set(jc, {
      jc,
      ac,
      ec,
      ref: text(cells[1])?.match(/\d+/)?.[0] ?? null,
      title,
      company: text(body.match(/<h1>([\s\S]*?)<\/h1>/)?.[1]),
      summary: summary && !NO_SUMMARY.test(summary) ? summary : null,
      opening_date: rowDate(text(cells[4])),
      closing_date: rowDate(text(cells[5])),
      town: text(cells[6]),
    });
  }
  const total = Number(html.match(/id="hdnTotalJobs"[^>]*value="(\d+)"|value="(\d+)"[^>]*id="hdnTotalJobs"/)?.slice(1).find(Boolean) ?? NaN);
  const next = html.match(/<a\s+href="([^"]*pageNo=\d+[^"]*)"\s*>\s*next\s*</i)?.[1] ?? null;
  return {
    rows: [...rows.values()],
    total: Number.isFinite(total) ? total : null,
    nextUrl: next ? new URL(decode(next), `${BASE}/applicant/`).toString() : null,
  };
}

function byId(html: string, id: string): string | null {
  const m = html.match(new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`, 'i'));
  return m ? m[2] : null;
}

function inputValue(html: string, id: string): string | null {
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i'))?.[0];
  const v = tag?.match(/\bvalue=["']([^"']*)["']/i)?.[1];
  return v ? decode(v).trim() || null : null;
}

/** The #remark block: everything up to the next sibling block. */
function remark(html: string): string | null {
  const start = html.search(/<div\b[^>]*\bid=["']remark["'][^>]*>/i);
  if (start < 0) return null;
  const open = html.indexOf('>', start) + 1;
  const end = html.slice(open).search(/<div\b[^>]*class="print-date|<div\b[^>]*class="vac-view-success-block|<div\b[^>]*id="ave-holder"/i);
  const inner = end < 0 ? html.slice(open) : html.slice(open, open + end);
  return inner.replace(/<\/div>\s*$/i, '').trim() || null;
}

function absolute(src: string): string | null {
  try {
    return new URL(decode(src).trim(), `${BASE}/employer/`).toString();
  } catch {
    return null;
  }
}

/** Under this much text in #remark, an ad with an image is an image ad (vision path). */
export const IMAGE_AD_MAX_TEXT = 100;

export interface AdDetail {
  jc: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  closing_date: string | null;
  labels: string[];
  remarkHtml: string | null;
  remarkText: string | null;
  images: string[];
  email: string | null;
  /** The ad shows topjobs' "Foreign" flag (#globalFlag) instead of "Sri Lankan" (#localFlag). */
  foreign: boolean;
}

export function parseAd(html: string): AdDetail {
  const loc = text(byId(html, 'adview-job-location')?.replace(/<div[\s\S]*$/i, ''));
  const rem = remark(html);
  const images = [...(rem ?? '').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => absolute(m[1])).filter((u): u is string => !!u);
  const end = text(byId(html, 'endDate'));
  const email = inputValue(html, 'txtAVECompanyEmail');
  return {
    jc: inputValue(html, 'jsCode'),
    title: text(byId(html, 'position')),
    company: text(byId(html, 'employer')),
    location: loc ? loc.replace(/,\s*Sri Lanka$/i, '').trim() || null : null,
    // The site always writes dd/mm/yyyy here, so day-first is a known format, not a guess.
    closing_date: end && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(end) ? parseDate(end) : null,
    labels: [...html.matchAll(/<label\b[^>]*class=["']lbl_fulltime["'][^>]*>([^<]*)<\/label>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean),
    remarkHtml: rem,
    remarkText: text(rem),
    images,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    foreign: /\bid=["']globalFlag["']/.test(html),
  };
}

const WORK_MODE = /^(onsite|on-site|remote|hybrid|work from home)$/i;

/**
 * One ScrapedJob from the listing row and the ad page. The listing's columns are the site's own
 * structured fields (dates, town, employer); the ad page fills title/company/location when the
 * row left them out, and adds the advert, the labels and the apply-by-email address.
 */
export function mapJob(row: ListingRow, ad: AdDetail, opts: { scrapedAt: string }): ScrapedJob | null {
  const title = row.title || ad.title;
  if (!title) return null;
  const url = adUrl(row.ac, row.jc, row.ec);
  const isImage = ad.images.length > 0 && (ad.remarkText ?? '').length < IMAGE_AD_MAX_TEXT;
  const mode = ad.labels.find((l) => WORK_MODE.test(l)) ?? null;
  const types = ad.labels.filter((l) => !WORK_MODE.test(l));

  const parts: string[] = [];
  // An image ad's own markup is just a relative <img>, which cleaning would strip; the absolute
  // image links below replace it. A text ad keeps its markup.
  if (ad.remarkHtml && !isImage) parts.push(ad.remarkHtml);
  if (!ad.remarkText && row.summary) parts.push(`<p>${row.summary}</p>`);
  // `images` are already absolute and percent-encoded (new URL()). The URL is also the link text,
  // because description cleaning drops attributes.
  for (const src of ad.images) parts.push(`<p>Advert image: <a href="${src}">${src}</a></p>`);

  return {
    title,
    company: row.company ?? ad.company,
    // A foreign job's town column says only "All island"; the ad page adds the country.
    location: ad.foreign ? ad.location ?? row.town : row.town ?? ad.location,
    description: parts.join('\n') || null,
    closing_date: row.closing_date ?? ad.closing_date,
    apply_method: ad.email ? 'email' : 'portal',
    apply_email: ad.email,
    apply_url: ad.email ? null : url,
    apply_instructions: ad.email ? null : 'Apply through a topjobs account (sign in yourself in the browser).',
    is_image_ad: isImage,
    posted_at: row.opening_date,
    external_id: row.jc,
    country_code: ad.foreign ? null : 'LK',
    remote: mode ? /remote|work from home/i.test(mode) : null,
    employment_type: types.length ? types.join(', ').slice(0, 60) : null,
    scraped_at: opts.scrapedAt,
    source_url: url,
  };
}
