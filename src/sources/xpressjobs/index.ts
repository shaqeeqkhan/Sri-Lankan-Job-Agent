/**
 * XpressJobs adapter (PRD §7.1, P1). Strategy verified 15 Nov 2026, see parse.ts:
 *   listing  sitemap.xml over ctx.http (one request, every open job id), newest id first;
 *            fallback: the site's own searchJobs JSON API, a few pages
 *   detail   api/jobs/publishedJob?jobId=<id> over ctx.http (JSON), one at a time
 *   recheck  the same detail call: 204 (not a published job), archived, or a passed expiry = closed
 */
import { SljError } from '../../errors.ts';
import { JobFields } from '../../jobs/schema.ts';
import type { HttpResponse, Liveness, ScrapedJob, SourceAdapter, SourceContext, SourceResult } from '../types.ts';
import { detailBudget } from '../util.ts';
import {
  API_BASE,
  SITEMAP_URL,
  detailApiUrl,
  detailLiveness,
  externalIdFromUrl,
  isDetail,
  isSitemap,
  mapDetail,
  parseSearchPage,
  parseSitemap,
  searchApiUrl,
  type SitemapEntry,
} from './parse.ts';

const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
const int = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);

/** Drift: this many detail bodies in a row that are not the expected shape, and nothing parsed. */
const DRIFT_AFTER = 3;

async function get(ctx: SourceContext, url: string, timeoutMs?: number): Promise<HttpResponse | null> {
  try {
    return await ctx.http.get(url, { headers: { accept: 'application/json, text/xml;q=0.9, */*;q=0.5' }, ...(timeoutMs ? { timeoutMs } : {}) });
  } catch {
    return null; // network failure after retries
  }
}

function json(res: HttpResponse | null): unknown {
  if (!res || res.status !== 200 || !res.text) return undefined;
  try {
    return JSON.parse(res.text);
  } catch {
    return undefined;
  }
}

/** Validate against JobFields; an invalid optional value is dropped rather than losing the job. */
export function finish(job: ScrapedJob): ScrapedJob | null {
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

async function listFromSitemap(ctx: SourceContext): Promise<SitemapEntry[] | null> {
  const res = await get(ctx, str(ctx.source.options.sitemap_url, SITEMAP_URL), 60_000);
  if (!res || res.status !== 200 || !isSitemap(res.text)) {
    ctx.log(`xpressjobs: sitemap unavailable (${res ? `HTTP ${res.status}` : 'network error'}); using the search API.`);
    return null;
  }
  const entries = parseSitemap(res.text);
  if (entries.length === 0) {
    ctx.log('xpressjobs: sitemap has no /jobs/view/ entries (drift?); using the search API.');
    return null;
  }
  return entries;
}

async function listFromApi(ctx: SourceContext, apiBase: string): Promise<SitemapEntry[]> {
  const pages = int(ctx.source.options.fallback_pages, 5);
  const pageSize = int(ctx.source.options.page_size, 100);
  const ids = new Set<string>();
  for (let p = 1; p <= pages; p++) {
    const body = json(await get(ctx, searchApiUrl(p, pageSize, apiBase)));
    const page = parseSearchPage(body);
    if (page.ids.length === 0) {
      if (p === 1) throw new SljError('FETCH_FAILED', 'xpressjobs: neither the sitemap nor the search API returned any jobs.', { source: 'xpressjobs' });
      break;
    }
    for (const id of page.ids) ids.add(id);
    if (page.total !== null && p * pageSize >= page.total) break;
  }
  return [...ids].sort((a, b) => Number(b) - Number(a)).map((id) => ({ id, url: '', lastmod: null }));
}

export async function scan(ctx: SourceContext): Promise<SourceResult> {
  const apiBase = str(ctx.source.options.api_base, API_BASE);
  const entries = (await listFromSitemap(ctx)) ?? (await listFromApi(ctx, apiBase));
  const since = ctx.since ? ctx.since.toISOString().slice(0, 10) : null;
  const scrapedAt = ctx.now().toISOString();

  const jobs: ScrapedJob[] = [];
  const deferred: string[] = [];
  const dropped: string[] = [];
  let skippedSeen = 0;
  const budget = detailBudget(ctx);
  let drift = 0;
  let gone = 0;

  for (const e of entries) {
    if (ctx.seen(e.id)) {
      skippedSeen++;
      continue;
    }
    // lastmod is never earlier than the posting date, so an old lastmod means an old posting.
    if (since && e.lastmod && e.lastmod < since) continue;
    if (!budget.take()) continue;

    const res = await get(ctx, detailApiUrl(e.id, apiBase));
    if (res && res.status === 204) {
      gone++; // listed a moment ago, no longer published
      dropped.push(e.id);
      continue;
    }
    const body = json(res);
    if (!isDetail(body)) {
      if (body !== undefined) drift++;
      deferred.push(e.id);
      if (drift >= DRIFT_AFTER && jobs.length === 0 && drift === budget.used) {
        throw new SljError('FETCH_FAILED', `xpressjobs: the job API answered ${drift} times in an unexpected shape (site changed?).`, { source: 'xpressjobs', reason: 'drift' });
      }
      continue;
    }
    const mapped = mapDetail(body, { sourceUrl: e.url || null, scrapedAt });
    const job = mapped && finish(mapped);
    if (!job) {
      deferred.push(e.id);
      continue;
    }
    if (since && job.posted_at && job.posted_at.slice(0, 10) < since) {
      dropped.push(e.id);
      continue;
    }
    jobs.push(job);
  }

  ctx.log(`xpressjobs: ${entries.length} listed, ${skippedSeen} already seen, ${jobs.length} new, ${deferred.length} deferred${gone ? `, ${gone} no longer published` : ''}.`);
  return { jobs, listed: entries.length, skippedSeen, deferred, dropped, truncated: budget.truncation() };
}

export async function recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness> {
  const id = /^\d+$/.test(job.external_id) ? job.external_id : externalIdFromUrl(job.source_url);
  if (!id) return 'unknown';
  const res = await get(ctx, detailApiUrl(id, str(ctx.source.options.api_base, API_BASE)));
  if (!res) return 'unknown';
  // The API's own "not a published job" answer: empty 204 (verified on a missing id).
  if (res.status === 204) return 'closed';
  const body = json(res);
  if (!isDetail(body)) return 'unknown';
  return detailLiveness(body, ctx.now().toISOString().slice(0, 10));
}

const adapter: SourceAdapter = { id: 'xpressjobs', scan, recheck };
export default adapter;
