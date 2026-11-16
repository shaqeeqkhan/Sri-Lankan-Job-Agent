import { listingFailed, runDetails } from '../itpro/runner.ts';
import { todayLk } from '../itpro/text.ts';
import type { SourceAdapter } from '../types.ts';
import { LISTING_URL, detailLiveness, imageViewLooksRight, isListingPage, parseImageView, parseListing, toJob } from './parse.ts';

const adapter: SourceAdapter = {
  id: 'governmentjobs',
  async scan(ctx) {
    const page = await ctx.ladder.page(LISTING_URL, { kind: 'listing', expect: isListingPage });
    if (!page.ok) throw listingFailed('governmentjobs', LISTING_URL, page.block?.detail ?? `HTTP ${page.status}`);
    const cards = parseListing(page.html);
    if (!cards.length) throw listingFailed('governmentjobs', LISTING_URL, 'no vacancy cards (layout changed?)');

    const today = todayLk(ctx.now());
    const since = ctx.since ? ctx.since.toISOString().slice(0, 10) : null;
    const open = cards.filter((c) => !(c.closing_date && c.closing_date < today) && !(since && c.published && c.published < since));
    const scrapedAt = ctx.now().toISOString();
    const result = await runDetails(ctx, open, async (card) => {
      const view = card.images.find((i) => i.lang === 'en') ?? card.images[0];
      if (!view) return { job: toJob(card, [], scrapedAt) }; // only an outside link: nothing more to read here
      const d = await ctx.ladder.page(view.url, { kind: 'detail', expect: imageViewLooksRight });
      if (!d.ok) return { defer: d.block?.detail ?? `HTTP ${d.status}` };
      return { job: toJob(card, parseImageView(d.html), scrapedAt) };
    });
    return { ...result, listed: cards.length };
  },
  async recheck(job, ctx) {
    const d = await ctx.ladder.page(job.source_url, { kind: 'detail', noCache: true });
    if (!d.ok) return 'unknown';
    return detailLiveness(d.html, todayLk(ctx.now()));
  },
};

export default adapter;
