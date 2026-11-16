import type { SourceAdapter, SourceContext } from '../types.ts';
import { RSS_URL, SITEMAP_URL, detailLiveness, detailLooksRight, isUnavailable, parseDetail, parseRss, parseSitemap, type ListingEntry } from './parse.ts';
import { listingFailed, runDetails } from './runner.ts';
import { todayLk } from './text.ts';

/** T0 first: sitemap.xml (every open job), then the RSS feed (25 newest) if the sitemap is down. */
async function listing(ctx: SourceContext): Promise<ListingEntry[]> {
  const why: string[] = [];
  for (const [url, parse] of [[SITEMAP_URL, parseSitemap], [RSS_URL, parseRss]] as const) {
    try {
      const res = await ctx.http.get(url);
      if (res.status !== 200) {
        why.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const entries = parse(res.text);
      if (entries.length) return entries;
      why.push(`${url}: no job URLs (layout changed?)`);
    } catch (err) {
      why.push(`${url}: ${(err as Error).message}`);
    }
  }
  throw listingFailed('itpro', SITEMAP_URL, why.join('; '));
}

const adapter: SourceAdapter = {
  id: 'itpro',
  async scan(ctx) {
    let entries = await listing(ctx);
    if (ctx.since) {
      const since = ctx.since.toISOString().slice(0, 10);
      // lastmod is on or after the posted date, so an older lastmod means an older posting.
      entries = entries.filter((e) => !e.lastmod || e.lastmod >= since);
    }
    const scrapedAt = ctx.now().toISOString();
    return runDetails(ctx, entries, async (e) => {
      const page = await ctx.ladder.page(e.url, { kind: 'detail', expect: detailLooksRight });
      if (!page.ok) return { defer: page.block?.detail ?? `HTTP ${page.status}` };
      if (isUnavailable(page.html)) return { skip: 'unavailable' };
      const job = parseDetail(page.html, page.jsonLd, e.url, scrapedAt);
      if (!job) return { defer: 'no JobPosting on the page' };
      if (ctx.since && job.posted_at && job.posted_at < ctx.since.toISOString().slice(0, 10)) return { skip: 'older than since' };
      return { job };
    });
  },
  async recheck(job, ctx) {
    const page = await ctx.ladder.page(job.source_url, { kind: 'detail', noCache: true, expect: detailLooksRight });
    if (!page.ok) return 'unknown';
    return detailLiveness(page.html, page.jsonLd, todayLk(ctx.now()));
  },
};

export default adapter;
