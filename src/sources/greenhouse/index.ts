import {
  SHARED_HOST_WORKERS,
  externalId,
  jsonOf,
  parseBoardEntry,
  runAtsScan,
  safeGet,
  splitExternalId,
  toScrapedJob,
  tryJson,
  type Board,
  type BoardProbe,
  type Candidate,
} from '../ats-common.ts';
import type { HttpClient, Liveness, SourceAdapter, SourceContext } from '../types.ts';
import { detailUrl, listIsSriLanka, listUrl, mapJob, type GhJob } from './parse.ts';

async function listBoard(http: HttpClient, slug: string): Promise<GhJob[]> {
  const res = await safeGet(http, listUrl(slug));
  if (res.status === 404) throw new Error(`not found on Greenhouse (slug may be wrong)`);
  return jsonOf<{ jobs?: GhJob[] }>(res, 'list').jobs ?? [];
}

export async function probe(http: HttpClient, entry: unknown): Promise<BoardProbe> {
  const b = parseBoardEntry('greenhouse', entry);
  try {
    const jobs = await listBoard(http, b.name);
    const sl = jobs.filter(listIsSriLanka);
    return {
      valid: true,
      total_postings: jobs.length,
      sri_lanka_postings: sl.length,
      sample_titles: sl.slice(0, 5).map((j) => j.title ?? '').filter(Boolean),
      company: b.company ?? jobs[0]?.company_name?.trim() ?? null,
    };
  } catch (err) {
    return { valid: false, total_postings: null, sri_lanka_postings: 0, sample_titles: [], company: b.company, reason: (err as Error).message };
  }
}

async function listCandidates(ctx: SourceContext, b: Board): Promise<Candidate[]> {
  const jobs = await listBoard(ctx.http, b.name);
  return jobs
    .filter((j) => j.id != null && listIsSriLanka(j))
    .map((j) => {
      const id = externalId(b.name, String(j.id));
      return {
        externalId: id,
        postedAt: (j.first_published ?? j.updated_at ?? '').slice(0, 10) || null,
        hostKey: 'boards-api.greenhouse.io',
        async build() {
          const res = await safeGet(ctx.http, detailUrl(b.name, String(j.id)));
          const detail = res.status === 200 ? tryJson<GhJob>(res) : null;
          if (!detail) return null;
          const m = mapJob(b.name, b.company, j, detail);
          return toScrapedJob({ ...m, source_url: m.apply_url || listUrl(b.name), external_id: id }, ctx.now()) ?? 'drop';
        },
      };
    });
}

/**
 * Board membership (prune_stale_jobs.py `greenhouse_live_ids`): the board's 404 = gone; a non-empty
 * list without the id = closed; an empty list or any error is ambiguous.
 */
export async function recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness> {
  const ref = splitExternalId(job.external_id);
  if (!ref) return 'unknown';
  const res = await safeGet(ctx.http, listUrl(ref.board));
  if (res.status === 404 || res.status === 410) return 'closed';
  if (res.status !== 200) return 'unknown';
  const jobs = tryJson<{ jobs?: GhJob[] }>(res)?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return 'unknown';
  return jobs.some((j) => String(j.id) === ref.posting) ? 'alive' : 'closed';
}

const adapter: SourceAdapter = {
  id: 'greenhouse',
  scan: (ctx) => runAtsScan(ctx, 'greenhouse', SHARED_HOST_WORKERS, (b) => listCandidates(ctx, b)),
  recheck,
};
export default adapter;
