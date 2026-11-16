/**
 * ikmanJOBS adapter (PRD §7.1, P1). Strategy verified 15 Nov 2026, see parse.ts:
 *   listing  /en/ads/sri-lanka/jobs?page=N through the ladder, newest first; paging stops at
 *            `options.max_pages`, at max_details new ads, or at a page whose ads were all seen
 *   detail   /en/ad/<slug> through the ladder: window.initialData + JobPosting JSON-LD
 *   recheck  HTTP 404/410, a status other than "published", or a passed deadline = closed
 */
import { SljError } from '../../errors.ts';
import { JobFields } from '../../jobs/schema.ts';
import type { Liveness, ScrapedJob, SourceAdapter, SourceContext } from '../types.ts';
import { detailBudget } from '../util.ts';
import { LISTING_URL, adState, adUrl, externalIdFromUrl, isAdPage, isListingPage, listingPageUrl, mapAd, parseListing, type ListingAd } from './parse.ts';

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

export async function scan(ctx: SourceContext) {
  const base = str(ctx.source.options.listing_url, LISTING_URL);
  const maxPages = int(ctx.source.options.max_pages, 8);
  const max = ctx.source.max_details;
  const since = ctx.since ? ctx.since.toISOString().slice(0, 10) : null;
  const scrapedAt = ctx.now().toISOString();

  const listedSlugs = new Set<string>();
  const candidates: ListingAd[] = [];
  let skippedSeen = 0;

  for (let p = 1; p <= maxPages; p++) {
    const page = await ctx.ladder.page(listingPageUrl(p, base), { kind: 'listing', expect: isListingPage });
    if (!page.ok) {
      if (p === 1) {
        throw new SljError('FETCH_FAILED', `ikman: the jobs listing could not be loaded (${page.block?.reason ?? 'error'}: ${page.block?.detail ?? `HTTP ${page.status}`}).`, { source: 'ikman', block: page.block ?? null });
      }
      ctx.log(`ikman: listing page ${p} failed (${page.block?.reason}: ${page.block?.detail}); stopping there.`);
      break;
    }
    const parsed = parseListing(page.html);
    if (!parsed.ok) {
      if (p === 1) throw new SljError('FETCH_FAILED', 'ikman: the listing page no longer carries its ads data (site changed?).', { source: 'ikman', reason: 'drift' });
      break;
    }
    if (parsed.ads.length === 0) break;
    let freshRegular = 0;
    for (const ad of parsed.ads) {
      if (listedSlugs.has(ad.slug)) continue;
      listedSlugs.add(ad.slug);
      if (ctx.seen(ad.slug)) {
        skippedSeen++;
        continue;
      }
      candidates.push(ad);
      if (!ad.featured) freshRegular++;
    }
    // Newest first: a page whose regular ads were all seen means the rest were seen too.
    if (freshRegular === 0 || candidates.length > max) break; // one past the cap, so a truncation is reported
  }

  const jobs: ScrapedJob[] = [];
  const deferred: string[] = [];
  const dropped: string[] = [];
  let gone = 0;
  const budget = detailBudget(ctx);
  for (const ad of candidates) {
    if (!budget.take()) continue;
    const page = await ctx.ladder.page(adUrl(ad.slug), { kind: 'detail', expect: isAdPage });
    if (!page.ok) {
      if (page.status === 404 || page.status === 410) {
        gone++;
        dropped.push(ad.slug);
      }
      else deferred.push(ad.slug);
      continue;
    }
    const mapped = mapAd(page.html, page.jsonLd, { slug: ad.slug, listing: ad, scrapedAt });
    const job = mapped && finish(mapped);
    if (!job) {
      deferred.push(ad.slug);
      continue;
    }
    if (since && job.posted_at && job.posted_at.slice(0, 10) < since) {
      dropped.push(ad.slug);
      continue;
    }
    jobs.push(job);
  }

  ctx.log(`ikman: ${listedSlugs.size} listed, ${skippedSeen} already seen, ${jobs.length} new, ${deferred.length} deferred${gone ? `, ${gone} removed` : ''}.`);
  return { jobs, listed: listedSlugs.size, skippedSeen, deferred, dropped, truncated: budget.truncation() };
}

export async function recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness> {
  const slug = externalIdFromUrl(job.source_url) ?? (/^[a-z0-9-]+$/i.test(job.external_id) ? job.external_id.toLowerCase() : null);
  if (!slug) return 'unknown';
  const page = await ctx.ladder.page(adUrl(slug), { kind: 'detail', noCache: true, expect: isAdPage });
  if (!page.ok) return page.status === 404 || page.status === 410 ? 'closed' : 'unknown'; // verified: a removed ad is HTTP 410
  if (page.staleAgeS != null) return 'unknown'; // a cached copy says nothing about today
  const st = adState(page.html);
  if (!st.found) return 'unknown';
  if (st.status && st.status !== 'published') return 'closed';
  if (st.deadline && st.deadline < ctx.now().toISOString().slice(0, 10)) return 'closed';
  return 'alive';
}

const adapter: SourceAdapter = { id: 'ikman', scan, recheck };
export default adapter;
