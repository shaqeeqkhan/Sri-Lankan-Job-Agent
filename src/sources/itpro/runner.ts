/**
 * The listing → detail loop shared by the S5 board adapters (itpro, dreamjobs, governmentjobs).
 * Entries arrive newest first; seen ids are skipped; details are fetched one at a time (one host,
 * one request in flight), capped at `max_details`. A failed detail is deferred, never stored thin.
 */
import { SljError } from '../../errors.ts';
import type { ScrapedJob, SourceContext, SourceResult } from '../types.ts';
import { detailBudget } from '../util.ts';

export interface Entry {
  external_id: string;
}

/** What one detail fetch produced: a job, "skip" (gone or closed, not an error), or "defer" (failed). */
export type DetailOutcome = { job: ScrapedJob } | { skip: string } | { defer: string };

export async function runDetails<E extends Entry>(
  ctx: SourceContext,
  entries: E[],
  fetchOne: (entry: E) => Promise<DetailOutcome>,
): Promise<SourceResult> {
  const jobs: ScrapedJob[] = [];
  const deferred: string[] = [];
  const dropped: string[] = [];
  let skippedSeen = 0;
  const todo: E[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.external_id)) continue;
    ids.add(e.external_id);
    if (ctx.seen(e.external_id)) {
      skippedSeen++;
      continue;
    }
    todo.push(e);
  }
  const cap = Math.max(0, ctx.source.max_details);
  if (todo.length > cap) ctx.log(`${ctx.source.id}: ${todo.length} new postings, fetching the newest ${cap}`);
  let skipped = 0;
  const budget = detailBudget(ctx);
  for (const e of todo) {
    if (!budget.take()) continue;
    let out: DetailOutcome;
    try {
      out = await fetchOne(e);
    } catch (err) {
      out = { defer: (err as Error).message };
    }
    if ('job' in out) jobs.push(out.job);
    else if ('skip' in out) {
      skipped++;
      dropped.push(e.external_id);
    }
    else {
      deferred.push(e.external_id);
      ctx.log(`${ctx.source.id}: deferred ${e.external_id} (${out.defer})`);
    }
  }
  ctx.log(`${ctx.source.id}: ${entries.length} listed, ${skippedSeen} seen, ${jobs.length} jobs, ${deferred.length} deferred${skipped ? `, ${skipped} gone` : ''}`);
  return { jobs, listed: entries.length, skippedSeen, deferred, dropped, truncated: budget.truncation() };
}

/** A whole-source failure (listing unreachable on every tier): `jobs scan` logs the source as PARTIAL. */
export function listingFailed(sourceId: string, url: string, why: string): SljError {
  return new SljError('FETCH_FAILED', `${sourceId}: listing ${url} could not be read (${why})`, { source: sourceId, url });
}
