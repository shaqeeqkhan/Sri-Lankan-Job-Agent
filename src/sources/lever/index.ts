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
import { PAGE_SIZE, listUrl, mapPosting, postingIsSriLanka, type LvPosting } from './parse.ts';

const MAX_PAGES = 20;

/** Every posting on the board, paging with skip/limit. */
export async function listBoard(http: HttpClient, slug: string, maxPages = MAX_PAGES): Promise<LvPosting[]> {
  const out: LvPosting[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await safeGet(http, listUrl(slug, page * PAGE_SIZE));
    if (res.status === 404) throw new Error('not found on Lever (slug may be wrong)');
    const batch = jsonOf<LvPosting[]>(res, 'postings');
    if (!Array.isArray(batch)) throw new Error('postings: not a list');
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

export async function probe(http: HttpClient, entry: unknown): Promise<BoardProbe> {
  const b = parseBoardEntry('lever', entry);
  try {
    const all = await listBoard(http, b.name);
    const sl = all.filter(postingIsSriLanka);
    return { valid: true, total_postings: all.length, sri_lanka_postings: sl.length, sample_titles: sl.slice(0, 5).map((p) => p.text ?? '').filter(Boolean), company: b.company };
  } catch (err) {
    return { valid: false, total_postings: null, sri_lanka_postings: 0, sample_titles: [], company: b.company, reason: (err as Error).message };
  }
}

async function listCandidates(ctx: SourceContext, b: Board): Promise<Candidate[]> {
  const all = await listBoard(ctx.http, b.name);
  return all
    .filter((p) => p.id && postingIsSriLanka(p))
    .map((p) => {
      const id = externalId(b.name, String(p.id).toLowerCase());
      const m = mapPosting(b.name, b.company, p);
      return {
        externalId: id,
        postedAt: isoDate(p.createdAt),
        hostKey: 'api.lever.co',
        build: async () => toScrapedJob({ ...m, source_url: m.apply_url ?? listUrl(b.name), external_id: id }, ctx.now()) ?? 'drop',
      };
    });
}

/** Board membership (prune_stale_jobs.py `lever_live_ids`). */
export async function recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness> {
  const ref = splitExternalId(job.external_id);
  if (!ref) return 'unknown';
  const ids = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await safeGet(ctx.http, listUrl(ref.board, page * PAGE_SIZE));
    if (res.status === 404 || res.status === 410) return page === 0 ? 'closed' : 'unknown';
    if (res.status !== 200) return 'unknown';
    const batch = tryJson<LvPosting[]>(res);
    if (!Array.isArray(batch)) return 'unknown';
    for (const p of batch) if (p.id) ids.add(String(p.id).toLowerCase());
    if (ids.has(ref.posting.toLowerCase())) return 'alive';
    if (batch.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) return 'unknown';
  }
  return ids.size ? 'closed' : 'unknown';
}

const adapter: SourceAdapter = {
  id: 'lever',
  scan: (ctx) => runAtsScan(ctx, 'lever', SHARED_HOST_WORKERS, (b) => listCandidates(ctx, b)),
  recheck,
};
export default adapter;
