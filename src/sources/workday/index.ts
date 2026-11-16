import {
  BoardError,
  JSON_HEADERS,
  WORKDAY_BOARD_WORKERS,
  externalId,
  jsonOf,
  parseBoardEntry,
  runAtsScan,
  safeGet,
  textIsSriLanka,
  toScrapedJob,
  tryJson,
  type BoardProbe,
  type Candidate,
  type WorkdayBoard,
} from '../ats-common.ts';
import type { HttpClient, Liveness, SourceAdapter, SourceContext } from '../types.ts';
import {
  PAGE_SIZE,
  detailUrl,
  isPlaceholder,
  mapPosting,
  parsePostingUrl,
  postedOnDate,
  postingId,
  postingUrl,
  searchBody,
  searchUrl,
  sriLankaFacet,
  type WdInfo,
  type WdPosting,
  type WdSearch,
} from './parse.ts';

const DEFAULT_MAX_PAGES = 25; // 500 Sri Lanka postings per board

async function search(http: HttpClient, b: WorkdayBoard, facets: Record<string, string[]>, offset: number, text = ''): Promise<WdSearch> {
  const res = await http.postJson(searchUrl(b), searchBody(facets, offset, text), { headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' } });
  if (res.status === 422) throw new BoardError(`HTTP 422: the tenant is right but the site "${b.site}" is wrong`, 422);
  return jsonOf<WdSearch>(res, 'search');
}

interface Listing {
  total: number;
  /** True when the Sri Lanka facet selected the postings; false for the text-search fallback. */
  viaFacet: boolean;
  slTotal: number;
  postings: WdPosting[];
}

/** Every Sri Lanka posting on one board, paging the CxS search. */
export async function listBoard(http: HttpClient, b: WorkdayBoard, maxPages = DEFAULT_MAX_PAGES): Promise<Listing> {
  const first = await search(http, b, {}, 0);
  const total = Number(first.total ?? 0);
  const facet = sriLankaFacet(first);
  if (facet === null) return { total, viaFacet: true, slTotal: 0, postings: [] };
  const applied = facet === 'none' ? {} : { [facet.param]: facet.ids };
  const text = facet === 'none' ? 'Sri Lanka' : '';
  const postings: WdPosting[] = [];
  let slTotal = 0;
  for (let page = 0; page < maxPages; page++) {
    const r = await search(http, b, applied, page * PAGE_SIZE, text);
    const batch = r.jobPostings ?? [];
    // CxS reports `total` on the first page only; later pages say 0.
    if (page === 0) slTotal = Number(r.total ?? 0);
    postings.push(...batch);
    if (batch.length < PAGE_SIZE || postings.length >= slTotal) break;
  }
  if (facet === 'none') {
    // Text search matches anywhere in the ad: keep Sri Lanka locations and placeholders ("2 Locations"),
    // which the detail fetch then checks against the posting's country.
    const kept = postings.filter((p) => textIsSriLanka(p.locationsText) || isPlaceholder(p.locationsText));
    return { total, viaFacet: false, slTotal: kept.length, postings: kept };
  }
  return { total, viaFacet: true, slTotal, postings };
}

export async function probe(http: HttpClient, entry: unknown): Promise<BoardProbe> {
  const b = parseBoardEntry('workday', entry) as WorkdayBoard;
  try {
    const l = await listBoard(http, b, 1);
    return {
      valid: true,
      total_postings: l.total,
      sri_lanka_postings: l.viaFacet ? l.slTotal : l.postings.filter((p) => textIsSriLanka(p.locationsText)).length,
      sample_titles: l.postings.slice(0, 5).map((p) => p.title ?? '').filter(Boolean),
      company: b.company,
    };
  } catch (err) {
    return { valid: false, total_postings: null, sri_lanka_postings: 0, sample_titles: [], company: b.company, reason: (err as Error).message };
  }
}

async function fetchDetail(http: HttpClient, b: WorkdayBoard, path: string): Promise<{ info: WdInfo; org: string | null } | null> {
  const res = await safeGet(http, detailUrl(b, path));
  if (res.status !== 200) return null;
  const d = tryJson<{ jobPostingInfo?: WdInfo; hiringOrganization?: { name?: string } }>(res);
  return d?.jobPostingInfo ? { info: d.jobPostingInfo, org: d.hiringOrganization?.name?.trim() || null } : null;
}

function idFor(b: WorkdayBoard, path: string): string {
  return externalId(`${b.tenant}/${b.site}`, postingId(path));
}

async function listCandidates(ctx: SourceContext, b: WorkdayBoard): Promise<Candidate[]> {
  const maxPages = Number(ctx.source.options.max_pages ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES;
  const l = await listBoard(ctx.http, b, maxPages);
  return l.postings
    .filter((p) => p.externalPath)
    .map((p) => {
      const path = p.externalPath!;
      const id = idFor(b, path);
      return {
        externalId: id,
        postedAt: postedOnDate(p.postedOn, ctx.now()),
        hostKey: `${b.tenant}.${b.wd}`,
        async build() {
          const d = await fetchDetail(ctx.http, b, path);
          if (!d) return null;
          const m = mapPosting(b, p, d.info, l.viaFacet);
          if (!m) return 'drop';
          return (
            toScrapedJob(
              { ...m, company: b.company ?? d.org ?? b.tenant, source_url: m.apply_url ?? postingUrl(b, path), external_id: id },
              ctx.now(),
            ) ?? 'drop'
          );
        },
      };
    });
}

/**
 * Workday's CxS detail has three answers (prune_stale_jobs.py `workday_status`):
 * 200 = published; 404 = gone; 403 with errorCode S22 = taken down. Anything else is unknown.
 */
export async function recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness> {
  const p = parsePostingUrl(job.source_url);
  if (!p) return 'unknown';
  const b = { family: 'workday', name: `${p.tenant}|${p.wd}|${p.site}`, company: null, tenant: p.tenant, wd: p.wd, site: p.site } as WorkdayBoard;
  const res = await safeGet(ctx.http, detailUrl(b, p.path));
  if (res.status === 404 || res.status === 410) return 'closed';
  if (res.status === 200) return tryJson(res)?.jobPostingInfo ? 'alive' : 'unknown';
  if (res.status === 403 && String(tryJson(res)?.errorCode ?? '').toUpperCase() === 'S22') return 'closed';
  return 'unknown';
}

const adapter: SourceAdapter = {
  id: 'workday',
  scan: (ctx) => runAtsScan<WorkdayBoard>(ctx, 'workday', WORKDAY_BOARD_WORKERS, (b) => listCandidates(ctx, b)),
  recheck,
};
export default adapter;
