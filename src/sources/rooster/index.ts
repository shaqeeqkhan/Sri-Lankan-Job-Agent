import { SljError } from '../../errors.ts';
import type { Liveness, ScrapedJob, SourceAdapter, SourceContext, SourceResult } from '../types.ts';
import { type RoosterItem, SEARCH_URL, isSriLanka, itemToJob, pageActive, parseSearch, searchBody } from './parse.ts';

function opt(ctx: SourceContext, key: string, dflt: number): number {
  const v = Number(ctx.source.options[key]);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt;
}

// The headers Rooster's own front end sends with its search call.
const HEADERS = { origin: 'https://rooster.jobs', referer: 'https://rooster.jobs/', accept: 'application/json' };

const adapter: SourceAdapter = {
  id: 'rooster',

  async scan(ctx): Promise<SourceResult> {
    const api = typeof ctx.source.options.api_url === 'string' && ctx.source.options.api_url ? ctx.source.options.api_url : SEARCH_URL;
    const limit = opt(ctx, 'page_size', 50);
    const pages = opt(ctx, 'max_pages', 30);
    const byId = new Map<string, RoosterItem>();
    let foreign = 0;

    for (let n = 1; n <= pages; n++) {
      const res = await ctx.http.postJson(api, searchBody(n, limit), { headers: HEADERS });
      const parsed = res.status >= 200 && res.status < 300 ? parseSearch(res.text) : null;
      if (!parsed) {
        const why = res.status >= 200 && res.status < 300 ? 'an unexpected answer (drift)' : `HTTP ${res.status}`;
        if (n === 1) throw new SljError('FETCH_FAILED', `rooster: job search API gave ${why}.`, { url: api, status: res.status });
        ctx.log(`rooster: search page ${n} gave ${why}; keeping the ${byId.size} jobs read so far`);
        break;
      }
      for (const item of parsed.items) {
        if (!isSriLanka(item)) {
          foreign++;
          continue;
        }
        byId.set(String(item.id), item);
      }
      if (parsed.items.length === 0 || n * limit >= parsed.count) break;
    }

    // Newest first. The listing carries the whole posting, so there is no detail fetch to defer.
    const items = [...byId.values()].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || Number(b.id) - Number(a.id));
    const jobs: ScrapedJob[] = [];
    let skippedSeen = 0;
    for (const item of items) {
      const id = String(item.id);
      if (ctx.seen(id)) {
        skippedSeen++;
        continue;
      }
      if (jobs.length >= ctx.source.max_details) break;
      const job = itemToJob(item, ctx.now());
      if (!job) continue;
      if (ctx.since && job.posted_at && new Date(`${job.posted_at}T23:59:59Z`) < ctx.since) continue;
      jobs.push(job);
    }
    ctx.log(`rooster: ${items.length} Sri Lanka postings (${foreign} elsewhere dropped), ${skippedSeen} seen, ${jobs.length} jobs`);
    return { jobs, listed: items.length, skippedSeen, deferred: [] };
  },

  async recheck(job, ctx): Promise<Liveness> {
    const page = await ctx.ladder.page(job.source_url, { kind: 'detail', noCache: true });
    if (!page.ok || page.staleAgeS !== undefined) return 'unknown';
    // An unknown id lands on /404-page with HTTP 200: ambiguous, so unknown.
    const active = pageActive(page.html);
    if (active === false) return 'closed';
    return active === true ? 'alive' : 'unknown';
  },
};

export default adapter;
