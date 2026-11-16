import { SljError } from '../../errors.ts';
import type { Liveness, ScrapedJob, SourceAdapter, SourceContext, SourceResult } from '../types.ts';
import { detailBudget } from '../util.ts';
import { type ListingCard, isListingPage, listingUrl, looksLikeJobPage, parseDetail, parseListing, todayLk } from './parse.ts';

function maxPages(ctx: SourceContext): number {
  const v = Number(ctx.source.options.max_pages);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 5;
}

const adapter: SourceAdapter = {
  id: 'jobeka',

  async scan(ctx): Promise<SourceResult> {
    const today = todayLk(ctx.now());
    const open = new Map<string, ListingCard>();
    let expiredOnListing = 0;

    // Listing pages are newest first and include expired postings: stop at the first page with no
    // open card, or at max_pages.
    const pages = maxPages(ctx);
    for (let n = 1; n <= pages; n++) {
      const url = listingUrl(n);
      const page = await ctx.ladder.page(url, { kind: 'listing', expect: isListingPage });
      if (!page.ok) {
        if (n === 1) {
          throw new SljError('FETCH_FAILED', `jobeka: listing page unavailable (${page.block?.reason ?? 'error'}: ${page.block?.detail ?? page.status}).`, { url, block: page.block });
        }
        ctx.log(`jobeka: listing page ${n} unavailable (${page.block?.reason ?? 'error'}); stopping there`);
        break;
      }
      const cards = parseListing(page.html);
      let openHere = 0;
      for (const c of cards) {
        if (open.has(c.external_id)) continue;
        if (c.deadline && c.deadline < today) {
          expiredOnListing++;
          continue;
        }
        open.set(c.external_id, c);
        openHere++;
      }
      if (openHere === 0) break;
    }

    const entries = [...open.values()].sort((a, b) => Number(b.external_id) - Number(a.external_id));
    const jobs: ScrapedJob[] = [];
    const deferred: string[] = [];
    const dropped: string[] = [];
    let skippedSeen = 0;
    const budget = detailBudget(ctx);
    for (const e of entries) {
      if (ctx.seen(e.external_id)) {
        skippedSeen++;
        continue;
      }
      if (!budget.take()) continue;
      const page = await ctx.ladder.page(e.url, { kind: 'detail', expect: looksLikeJobPage });
      if (!page.ok) {
        deferred.push(e.external_id);
        continue;
      }
      const { job, expired } = parseDetail(page.html, page.jsonLd, e.url, ctx.now());
      if (!job) {
        deferred.push(e.external_id);
        continue;
      }
      // Read but not worth storing: marked seen by `jobs scan`, so it is not fetched again next scan.
      if (expired || (job.closing_date && job.closing_date < today) || (ctx.since && job.posted_at && new Date(`${job.posted_at}T23:59:59+05:30`) < ctx.since)) {
        dropped.push(e.external_id);
        continue;
      }
      jobs.push(job);
    }
    ctx.log(`jobeka: ${entries.length} open on listings (${expiredOnListing} expired skipped), ${skippedSeen} seen, ${jobs.length} jobs, ${deferred.length} deferred, ${dropped.length} closed or old`);
    return { jobs, listed: entries.length, skippedSeen, deferred, dropped, truncated: budget.truncation() };
  },

  async recheck(job, ctx): Promise<Liveness> {
    const page = await ctx.ladder.page(job.source_url, { kind: 'detail', noCache: true });
    // JobEka never answered 404 for a job URL (gone ids redirect to /browse), so a failed
    // fetch is not a signal either way.
    if (!page.ok) return 'unknown';
    if (page.staleAgeS !== undefined) return 'unknown';
    const { job: parsed, expired } = parseDetail(page.html, page.jsonLd, job.source_url, ctx.now());
    if (expired) return 'closed';
    // An unknown id redirects to /browse (soft 404): ambiguous, so unknown.
    if (!parsed) return 'unknown';
    if (parsed.closing_date && parsed.closing_date < todayLk(ctx.now())) return 'closed';
    return 'alive';
  },
};

export default adapter;
