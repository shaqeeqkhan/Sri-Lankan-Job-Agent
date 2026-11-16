import {
  SHARED_HOST_WORKERS,
  externalId,
  isoDate,
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
import { jobIsSriLanka, listUrl, mapJob, type AbJob } from './parse.ts';

async function listBoard(http: HttpClient, org: string): Promise<AbJob[]> {
  const res = await safeGet(http, listUrl(org));
  if (res.status === 404) throw new Error('not found on Ashby (org may be wrong)');
  const jobs = jsonOf<{ jobs?: AbJob[] }>(res, 'job board').jobs;
  if (!Array.isArray(jobs)) throw new Error('job board: no jobs list');
  return jobs;
}

export async function probe(http: HttpClient, entry: unknown): Promise<BoardProbe> {
  const b = parseBoardEntry('ashby', entry);
  try {
    const all = (await listBoard(http, b.name)).filter((j) => j.isListed !== false);
    const sl = all.filter(jobIsSriLanka);
    return { valid: true, total_postings: all.length, sri_lanka_postings: sl.length, sample_titles: sl.slice(0, 5).map((j) => j.title ?? '').filter(Boolean), company: b.company };
  } catch (err) {
    return { valid: false, total_postings: null, sri_lanka_postings: 0, sample_titles: [], company: b.company, reason: (err as Error).message };
  }
}

async function listCandidates(ctx: SourceContext, b: Board): Promise<Candidate[]> {
  const all = await listBoard(ctx.http, b.name);
  return all
    .filter((j) => j.id && jobIsSriLanka(j))
    .map((j) => {
      const id = externalId(b.name, String(j.id).toLowerCase());
      const m = mapJob(b.name, b.company, j);
      return {
        externalId: id,
        postedAt: isoDate(j.publishedAt),
        hostKey: 'api.ashbyhq.com',
        build: async () => toScrapedJob({ ...m, source_url: m.apply_url ?? listUrl(b.name), external_id: id }, ctx.now()) ?? 'drop',
      };
    });
}

/** Board membership (prune_stale_jobs.py `ashby_live_ids`); an unlisted posting is closed too. */
export async function recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness> {
  const ref = splitExternalId(job.external_id);
  if (!ref) return 'unknown';
  const res = await safeGet(ctx.http, listUrl(ref.board));
  if (res.status === 404 || res.status === 410) return 'closed';
  if (res.status !== 200) return 'unknown';
  const jobs = tryJson<{ jobs?: AbJob[] }>(res)?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return 'unknown';
  const hit = jobs.find((j) => String(j.id).toLowerCase() === ref.posting.toLowerCase());
  if (!hit) return 'closed';
  return hit.isListed === false ? 'closed' : 'alive';
}

const adapter: SourceAdapter = {
  id: 'ashby',
  scan: (ctx) => runAtsScan(ctx, 'ashby', SHARED_HOST_WORKERS, (b) => listCandidates(ctx, b)),
  recheck,
};
export default adapter;
