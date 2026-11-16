/**
 * governmentjobs.lk parsing (verified against the live site on 15 Nov 2026).
 *
 * Government vacancies copied from gazettes and institution websites. Almost every ad is a scan:
 * the text lives in images, so jobs are image ads and the agent reads them with vision later.
 *
 * - Listing: https://governmentjobs.lk/index.php?page=1&ipp=All& is every open vacancy on one page
 *   (55 on 15 Nov 2026). Each card has the title, "Closing Date: YYYY-MM-DD", "Ref No : G-017486",
 *   the institution tag, "Source: <site> (YYYY.MM.DD)", "Published Date: YYYY-MM-DD", links to the ad
 *   images (image-view.php?vid=<aid>&type=en|si) and sometimes an "Application" link (an online
 *   form, a careers page, or an application form on Google Drive).
 * - The posting id is the `aid` parameter of vacancy_details.php?aid=<aid>. The detail page repeats
 *   the card and adds only generic text, so it is not fetched during a scan.
 * - "Detail" here is image-view.php, which holds the ad images (S3 URLs, one per page of the ad).
 *   English is preferred; Sinhala when it is the only one.
 * - Sinhala titles on the site are in a legacy font encoding (FM Abhaya style), not Unicode; they are
 *   ignored.
 * - An unknown aid answers 200 with an empty body.
 */
import { decodeEntities, htmlToText } from '../../jobs/extract.ts';
import type { ScrapedJob } from '../types.ts';

export const BASE = 'https://governmentjobs.lk';
export const LISTING_URL = `${BASE}/index.php?page=1&ipp=All&`;

export interface Card {
  external_id: string;           // aid
  url: string;                   // vacancy_details.php?aid=…
  title: string;
  ref_no: string | null;
  institution: string | null;
  closing_date: string | null;
  published: string | null;
  source_note: string | null;    // "gwu.ac.lk (2026.11.04)"
  images: { lang: 'en' | 'si'; url: string }[];   // image-view.php pages to read for the ad images
  ad_files: string[];                              // the ad itself, hosted elsewhere (Google Drive PDF/image)
  links: { label: string; url: string }[];         // "Application" links
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
function isoOrNull(s: string | null | undefined): string | null {
  const m = s?.trim().match(ISO);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCDate() === +m[3] && d.getUTCMonth() === +m[2] - 1 ? m[0] : null;
}

function abs(href: string): string {
  const h = decodeEntities(href.trim());
  if (/^https?:\/\//i.test(h)) return h;
  return `${BASE}/${h.replace(/^\/+/, '')}`;
}

/** The aid in a vacancy_details.php URL, else null. */
export function governmentjobsId(url: string): string | null {
  try {
    const u = new URL(url, BASE);
    if (!/(^|\.)governmentjobs\.lk$/i.test(u.hostname) || !/vacancy_details\.php$/i.test(u.pathname)) return null;
    return u.searchParams.get('aid') || null;
  } catch {
    return null;
  }
}

export function isListingPage(html: string): boolean {
  return html.includes('vacancy_details.php?aid=');
}

function text(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = htmlToText(s).replace(/\s+/g, ' ').trim();
  return t || null;
}

/** Every vacancy card on a listing page, in page order (newest first on the site). */
export function parseListing(html: string): Card[] {
  const out = new Map<string, Card>();
  for (const block of html.split(/<div class=["']grid-view product["']>/i).slice(1)) {
    const b = block.slice(0, 8000);
    const head = b.match(/<h5>\s*<a\s+href=["'](vacancy_details\.php\?aid=[^"']+)["']\s*>\s*<strong>([\s\S]*?)<\/strong>/i);
    if (!head) continue;
    const url = abs(head[1]);
    const aid = governmentjobsId(url);
    const title = text(head[2]);
    if (!aid || !title || out.has(aid)) continue;

    // Buttons: <span class="add-to-cart"> is the advertisement ("more details", English or Sinhala):
    // image-view.php on the site, or a file elsewhere (Google Drive). <span class="add-to-compare"> is
    // the "Application" link.
    const images: Card['images'] = [];
    const adFiles: string[] = [];
    const links: Card['links'] = [];
    for (const m of b.matchAll(/<span class=["'](add-to-cart|add-to-compare)["']>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decodeEntities(m[2]).trim();
      if (m[1].toLowerCase() === 'add-to-cart') {
        const iv = href.match(/^image-view\.php\?vid=[^&]+&(?:amp;)?type=(en|si)$/i);
        if (iv) {
          const lang = iv[1].toLowerCase() as 'en' | 'si';
          if (!images.some((i) => i.lang === lang)) images.push({ lang, url: abs(href) });
        } else if (/^https?:\/\//i.test(href) && !adFiles.includes(href)) adFiles.push(href);
      } else if (/^https?:\/\//i.test(href)) {
        const label = text(m[3].match(/<strong[^>]*>([^<]*)<\/strong>/i)?.[1]) ?? 'Application';
        links.push({ label, url: href });
      }
    }

    const source = b.match(/Source:\s*([^<]+?)\s*<\/p>/i)?.[1];
    out.set(aid, {
      external_id: aid,
      url,
      title: title.slice(0, 300),
      ref_no: b.match(/Ref No\s*:\s*([A-Z0-9-]+)/i)?.[1] ?? null,
      institution: text(b.match(/icon-tag["'][^>]*><\/i>\s*<a[^>]*>([^<]+)<\/a>/i)?.[1])?.slice(0, 200) ?? null,
      closing_date: isoOrNull(b.match(/Closing Date:\s*([0-9-]+)/i)?.[1]),
      published: isoOrNull(b.match(/Published Date:\s*([0-9-]+)/i)?.[1]),
      source_note: source ? decodeEntities(source).replace(/\s+/g, ' ').trim() : null,
      images,
      ad_files: adFiles,
      links,
    });
  }
  return [...out.values()];
}

/** The ad images (and any PDF) on an image-view page. */
export function parseImageView(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+\/vacancy\/[^"']+\.(?:jpe?g|png|webp|gif|pdf))["']/gi)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+\.pdf)["']/gi)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function imageViewLooksRight(html: string): boolean {
  return parseImageView(html).length > 0;
}

function isDocumentLink(url: string): boolean {
  return /drive\.google\.com|docs\.google\.com|\.pdf(?:$|\?)/i.test(url);
}

/** A ScrapedJob from a listing card plus the ad files read from its image-view page. */
export function toJob(card: Card, viewFiles: string[], scrapedAt: string): ScrapedJob {
  const adFiles = [...viewFiles, ...card.ad_files.filter((u) => !viewFiles.includes(u))];
  const lines: string[] = [];
  lines.push(`<p>${escapeHtml(card.title)}</p>`);
  if (card.institution) lines.push(`<p>Institution: ${escapeHtml(card.institution)}</p>`);
  if (card.ref_no) lines.push(`<p>governmentjobs.lk ref: ${escapeHtml(card.ref_no)}</p>`);
  if (card.source_note) lines.push(`<p>Original source: ${escapeHtml(card.source_note)}</p>`);
  if (card.closing_date) lines.push(`<p>Closing date: ${card.closing_date}</p>`);
  if (adFiles.length) {
    lines.push('<p>The advertisement is an image or PDF. Read these files for the full details:</p>');
    lines.push(`<ul>${adFiles.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul>`);
  }
  const forms = card.links.filter((l) => isDocumentLink(l.url));
  const online = card.links.filter((l) => !isDocumentLink(l.url));
  for (const l of card.links) lines.push(`<p>${escapeHtml(l.label)}: ${escapeHtml(l.url)}</p>`);

  const instructions: string[] = [];
  if (forms.length) instructions.push(`Application form: ${forms.map((l) => l.url).join(' , ')}`);
  instructions.push('Read the advertisement for how and where to send the application.');

  return {
    title: card.title,
    company: card.institution,
    location: null,
    category: 'Government',
    description: lines.join('\n'),
    closing_date: card.closing_date,
    posted_at: card.published,
    apply_method: online.length ? 'portal' : null,
    apply_url: online[0]?.url ?? null,
    apply_instructions: instructions.join(' ').slice(0, 2000),
    is_image_ad: adFiles.length > 0,
    country_code: 'LK',
    external_id: card.external_id,
    source_url: card.url,
    scraped_at: scrapedAt,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** For recheck on vacancy_details.php: closed when its closing date has passed. */
export function detailLiveness(html: string, today: string): 'alive' | 'closed' | 'unknown' {
  const card = parseListing(html)[0];
  if (!card?.closing_date) return 'unknown';
  return card.closing_date < today ? 'closed' : 'alive';
}
