import { SljError } from '../../errors.ts';
import type { Liveness, ScrapedJob, SourceAdapter, SourceContext, SourceResult } from '../types.ts';
import { detailBudget } from '../util.ts';
import { SITEMAP_URL, isSitemap, looksLikeJobPage, parseDetail, parseSitemap, todayLk } from './parse.ts';

function sitemapUrl(ctx: SourceContext): string {
  const v = ctx.source.options.sitemap_url;
  return typeof v === 'string' && v ? v : SITEMAP_URL;
}

const adapter: SourceAdapter = {
  id: 'hotjobs',

  async scan(ctx): Promise<SourceResult> {
    const listing = sitemapUrl(ctx);
    const res = await ctx.http.get(listing);
    if (res.status !== 200) throw new SljError('FETCH_FAILED', `hotjobs: sitemap answered HTTP ${res.status}.`, { url: listing });
    if (!isSitemap(res.text)) {
      throw new SljError('FETCH_FAILED', 'hotjobs: the jobs sitemap is not a <urlset> any more (layout drift).', { url: listing, reason: 'drift' });
    }
    const entries = parseSitemap(res.text);
    const today = todayLk(ctx.now());
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
      // lastmod is never earlier than the posting date, so an old lastmod means an old posting.
      if (ctx.since && e.lastmod && new Date(e.lastmod) < ctx.since) continue;
      if (!budget.take()) continue;
      const page = await ctx.ladder.page(e.url, { kind: 'detail', expect: looksLikeJobPage });
      if (!page.ok) {
        deferred.push(e.external_id);
        continue;
      }
      const { job, active } = parseDetail(page.html, page.jsonLd, e.url, ctx.now());
      if (!job) {
        deferred.push(e.external_id);
        continue;
      }
      // Read but not worth storing: marked seen by `jobs scan`, so it is not fetched again next scan.
      if (active === false || (job.closing_date && job.closing_date < today)) {
        dropped.push(e.external_id);
        continue;
      }
      if (ctx.since && job.posted_at && new Date(`${job.posted_at}T23:59:59+05:30`) < ctx.since) {
        dropped.push(e.external_id);
        continue;
      }
      jobs.push(job);
    }
    ctx.log(`hotjobs: ${entries.length} in sitemap, ${skippedSeen} seen, ${budget.used} fetched, ${jobs.length} jobs, ${deferred.length} deferred, ${dropped.length} closed or old`);
    return { jobs, listed: entries.length, skippedSeen, deferred, dropped, truncated: budget.truncation() };
  },

  async recheck(job, ctx): Promise<Liveness> {
    const page = await ctx.ladder.page(job.source_url, { kind: 'detail', noCache: true });
    if (!page.ok) {
      // HotJobs answers a real 404 for a posting that is gone (checked 2026-11-15).
      return page.status === 404 || page.status === 410 ? 'closed' : 'unknown';
    }
    if (page.staleAgeS !== undefined) return 'unknown'; // a cached copy says nothing about today

    const { job: parsed, active } = parseDetail(page.html, page.jsonLd, job.source_url, ctx.now());
    if (!parsed) return 'unknown';
    if (active === false) return 'closed';
    if (parsed.closing_date && parsed.closing_date < todayLk(ctx.now())) return 'closed';
    return 'alive';
  },
};

export default adapter;
