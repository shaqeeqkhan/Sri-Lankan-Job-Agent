import { runDetails, listingFailed } from '../itpro/runner.ts';
import { todayLk } from '../itpro/text.ts';
import type { SourceAdapter } from '../types.ts';
import { LISTING_URL, detailLiveness, detailLooksRight, isBrowsePage, parseDetail, parseIndustries, parseJobLinks, type ListingEntry } from './parse.ts';

const adapter: SourceAdapter = {
  id: 'dreamjobs',
  async scan(ctx) {
    const page = await ctx.ladder.page(LISTING_URL, { kind: 'listing', expect: isBrowsePage });
    if (!page.ok) throw listingFailed('dreamjobs', LISTING_URL, page.block?.detail ?? `HTTP ${page.status}`);
    const entries: ListingEntry[] = parseJobLinks(page.html);
    const have = new Set(entries.map((e) => e.external_id));
    // An industry whose count is larger than the links shown: read its own page for the rest.
    for (const ind of parseIndustries(page.html)) {
      if (ind.count <= ind.shown) continue;
      const more = await ctx.ladder.page(ind.url, { kind: 'listing' });
      if (!more.ok) {
        ctx.log(`dreamjobs: ${ind.url} unreadable (${more.block?.detail ?? more.status}); ${ind.count - ind.shown} jobs not listed`);
        continue;
      }
      for (const e of parseJobLinks(more.html)) {
        if (!have.has(e.external_id)) {
          have.add(e.external_id);
          entries.push(e);
        }
      }
    }
    // The site gives no posted date on the listing; slugs are not ordered, so keep page order.
    const scrapedAt = ctx.now().toISOString();
    return runDetails(ctx, entries, async (e) => {
      const d = await ctx.ladder.page(e.url, { kind: 'detail', expect: detailLooksRight });
      if (!d.ok) return { defer: d.block?.detail ?? `HTTP ${d.status}` };
      const job = parseDetail(d.html, d.jsonLd, e.url, scrapedAt);
      if (!job) return { skip: 'expired' };
      if (ctx.since && job.posted_at && job.posted_at < ctx.since.toISOString().slice(0, 10)) return { skip: 'older than since' };
      return { job };
    });
  },
  async recheck(job, ctx) {
    const d = await ctx.ladder.page(job.source_url, { kind: 'detail', noCache: true, expect: detailLooksRight });
    if (!d.ok) return d.status === 404 ? 'closed' : 'unknown';
    return detailLiveness(d.html, d.jsonLd, job.source_url, todayLk(ctx.now()));
  },
};

export default adapter;
