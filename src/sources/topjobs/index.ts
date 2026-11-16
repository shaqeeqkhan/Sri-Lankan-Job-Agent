/**
 * topjobs.lk adapter (PRD §7.1, P1). Strategy verified 15 Nov 2026, see parse.ts:
 *   listing  "All Vacancies" table (~1,000 rows a page, newest first) through the ladder; paging
 *            follows the page's own "next" link up to `options.max_pages`
 *   detail   JobAdvertismentServlet?ac&jc&ec through the ladder: advert (usually one image),
 *            work labels and the apply-by-email address
 *   recheck  a passed closing date on the ad page = closed; anything else is unknown or alive
 * Plain HTTP worked on every page tried, so T1 comes first; the browser tiers stay as fallbacks
 * (waitFor selectors are set for them).
 */
import { SljError } from '../../errors.ts';
import { JobFields } from '../../jobs/schema.ts';
import type { Liveness, ScrapedJob, SourceAdapter, SourceContext } from '../types.ts';
import { detailBudget } from '../util.ts';
import { BASE, LISTING_URL, adUrl, externalIdFromUrl, isAdPage, isErrorPage, isListingPage, mapJob, parseAd, parseListing, type ListingRow } from './parse.ts';

const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
const int = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);

/** Validate against JobFields; an invalid optional value is dropped rather than losing the job. */
function finish(job: ScrapedJob): ScrapedJob | null {
  let cur: Record<string, unknown> = { ...job };
  for (let i = 0; i < 5; i++) {
    const r = JobFields.safeParse(cur);
    if (r.success) return { ...(r.data as JobFields), source_url: job.source_url, external_id: job.external_id };
    const bad = new Set(r.error.issues.map((x) => String(x.path[0])));
    if (bad.has('title')) return null;
    cur = { ...cur };
    for (const k of bad) cur[k] = null;
  }
  return null;
}

/** The ad page, or the site's own error page (a dead link is an answer, not drift to escalate). */
const adOrError = (html: string) => isAdPage(html) || isErrorPage(html);
const DETAIL = { kind: 'detail' as const, waitFor: '#position', expect: adOrError };

export async function scan(ctx: SourceContext) {
  const maxPages = int(ctx.source.options.max_pages, 2);
  const max = ctx.source.max_details;
  const since = ctx.since ? ctx.since.toISOString().slice(0, 10) : null;
  const scrapedAt = ctx.now().toISOString();

  const listed = new Set<string>();
  const candidates: ListingRow[] = [];
  let skippedSeen = 0;
  let url: string | null = str(ctx.source.options.listing_url, LISTING_URL);

  for (let p = 1; p <= maxPages && url; p++) {
    const page = await ctx.ladder.page(url, { kind: 'listing', waitFor: 'tr[id^="tr"]', expect: isListingPage });
    if (!page.ok) {
      if (p === 1) {
        throw new SljError('FETCH_FAILED', `topjobs: the vacancy list could not be loaded (${page.block?.reason ?? 'error'}: ${page.block?.detail ?? `HTTP ${page.status}`}).`, { source: 'topjobs', block: page.block ?? null });
      }
      ctx.log(`topjobs: listing page ${p} failed (${page.block?.reason}: ${page.block?.detail}); stopping there.`);
      break;
    }
    const parsed = parseListing(page.html);
    if (parsed.rows.length === 0) {
      if (p === 1 && parsed.total !== 0) throw new SljError('FETCH_FAILED', 'topjobs: the vacancy list parsed to 0 rows (site changed?).', { source: 'topjobs', reason: 'drift' });
      break;
    }
    let fresh = 0;
    let old = 0;
    for (const row of parsed.rows) {
      if (listed.has(row.jc)) continue;
      listed.add(row.jc);
      if (ctx.seen(row.jc)) {
        skippedSeen++;
        continue;
      }
      if (since && row.opening_date && row.opening_date < since) {
        old++;
        continue;
      }
      candidates.push(row);
      fresh++;
    }
    // Newest first: a page with nothing new, or one that reached postings older than `since`, ends it.
    if (fresh === 0 || old > 0 || candidates.length > max) break; // one past the cap, so a truncation is reported
    url = parsed.nextUrl;
  }

  const jobs: ScrapedJob[] = [];
  const deferred: string[] = [];
  const budget = detailBudget(ctx);
  for (const row of candidates) {
    if (!budget.take()) continue;
    const page = await ctx.ladder.page(adUrl(row.ac, row.jc, row.ec), DETAIL);
    if (!page.ok || isErrorPage(page.html, page.finalUrl)) {
      deferred.push(row.jc);
      continue;
    }
    const mapped = mapJob(row, parseAd(page.html), { scrapedAt });
    const job = mapped && finish(mapped);
    if (!job) {
      deferred.push(row.jc);
      continue;
    }
    jobs.push(job);
  }

  const images = jobs.filter((j) => j.is_image_ad).length;
  ctx.log(`topjobs: ${listed.size} listed, ${skippedSeen} already seen, ${jobs.length} new (${images} image ads), ${deferred.length} deferred.`);
  return { jobs, listed: listed.size, skippedSeen, deferred, truncated: budget.truncation() };
}

export async function recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness> {
  const jc = externalIdFromUrl(job.source_url) ?? (/^\d{5,}$/.test(job.external_id) ? job.external_id : null);
  if (!jc || !job.source_url.startsWith(BASE)) return 'unknown';
  const page = await ctx.ladder.page(job.source_url, { ...DETAIL, noCache: true });
  // topjobs never hard-404s an ad (a bad link is a 200 error page), so a failure is ambiguous.
  if (!page.ok || page.staleAgeS != null || isErrorPage(page.html, page.finalUrl)) return 'unknown';
  const ad = parseAd(page.html);
  if (ad.jc && ad.jc !== jc) return 'unknown';
  if (ad.closing_date && ad.closing_date < ctx.now().toISOString().slice(0, 10)) return 'closed';
  return ad.title ? 'alive' : 'unknown';
}

const adapter: SourceAdapter = { id: 'topjobs', scan, recheck };
export default adapter;
