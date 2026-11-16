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
import { PAGE_SIZE, detailUrl, mapPosting, postingIsSriLanka, postingUrl, searchUrl, type SrPosting, type SrSearch } from './parse.ts';

const MAX_PAGES = 10;

async function page(http: HttpClient, company: string, offset: number, limit = PAGE_SIZE, country: string | null = 'lk'): Promise<SrSearch> {
  const res = await safeGet(http, searchUrl(company, offset, limit, country));
  if (res.status === 404) throw new Error('not found on SmartRecruiters (company id may be wrong; ids are case-sensitive)');
  return jsonOf<SrSearch>(res, 'postings');
}

/** Every Sri Lanka posting on the board. */
export async function listBoard(http: HttpClient, company: string, maxPages = MAX_PAGES): Promise<SrPosting[]> {
  const out: SrPosting[] = [];
  for (let p = 0; p < maxPages; p++) {
    const r = await page(http, company, p * PAGE_SIZE);
    const batch = r.content ?? [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE || out.length >= Number(r.totalFound ?? 0)) break;
  }
  // The country filter is the API's; the location check guards against it being ignored.
  return out.filter(postingIsSriLanka);
}

export async function probe(http: HttpClient, entry: unknown): Promise<BoardProbe> {
  const b = parseBoardEntry('smartrecruiters', entry);
  try {
    const all = await page(http, b.name, 0, 1, null);
    const total = Number(all.totalFound ?? 0);
    if (total === 0) {
      return { valid: false, total_postings: 0, sri_lanka_postings: 0, sample_titles: [], company: b.company, reason: 'no postings: the company id is wrong (ids are case-sensitive) or the board is empty' };
    }
    const sl = await listBoard(http, b.name, 1);
    return {
      valid: true,
      total_postings: total,
      sri_lanka_postings: sl.length,
      sample_titles: sl.slice(0, 5).map((p) => p.name ?? '').filter(Boolean),
      company: b.company ?? all.content?.[0]?.company?.name?.trim() ?? null,
    };
  } catch (err) {
    return { valid: false, total_postings: null, sri_lanka_postings: 0, sample_titles: [], company: b.company, reason: (err as Error).message };
  }
}

async function listCandidates(ctx: SourceContext, b: Board): Promise<Candidate[]> {
  const all = await listBoard(ctx.http, b.name);
  return all
    .filter((p) => p.id != null)
    .map((p) => {
      const pid = String(p.id);
      const id = externalId(b.name, pid);
      return {
        externalId: id,
        postedAt: isoDate(p.releasedDate),
        hostKey: 'api.smartrecruiters.com',
        async build() {
          const res = await safeGet(ctx.http, detailUrl(b.name, pid));
          const d = res.status === 200 ? tryJson<SrPosting>(res) : null;
          if (!d) return null;
          if (d.active === false) return 'drop';
          const m = mapPosting(b.name, b.company, p, d);
          return toScrapedJob({ ...m, source_url: postingUrl(b.name, pid), external_id: id }, ctx.now()) ?? 'drop';
        },
      };
    });
}

/** The posting's own `active` flag (prune_stale_jobs.py `smartrecruiters_status`); 404/410 = gone. */
export async function recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness> {
  const ref = splitExternalId(job.external_id);
  if (!ref) return 'unknown';
  const res = await safeGet(ctx.http, detailUrl(ref.board, ref.posting));
  if (res.status === 404 || res.status === 410) return 'closed';
  if (res.status !== 200) return 'unknown';
  const d = tryJson<SrPosting>(res);
  if (!d || typeof d.active !== 'boolean') return 'unknown';
  return d.active ? 'alive' : 'closed';
}

const adapter: SourceAdapter = {
  id: 'smartrecruiters',
  scan: (ctx) => runAtsScan(ctx, 'smartrecruiters', SHARED_HOST_WORKERS, (b) => listCandidates(ctx, b)),
  recheck,
};
export default adapter;
