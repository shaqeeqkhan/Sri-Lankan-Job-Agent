/**
 * Scan status files (PRD §7.2, ported from ThreatHire `main.py` `_write_status` / `_low_sources`):
 * - user/scan_status.json: the latest result for every source that has run (a run of a few sources
 *   updates only their entries, so `jobs scan --sources topjobs` as its own step keeps the rest);
 * - user/scan_history.jsonl: one line per scan, the last 60;
 * - source_runs rows in the DB.
 * Writing status never fails a scan.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../context.ts';
import type { Tier } from './types.ts';

export const HISTORY_KEEP = 60;
export const LOW_MEDIAN_RUNS = 7;
export const LOW_FRACTION = 0.3;
export const LOW_MIN_HISTORY = 3;

/** ok | degraded:<tier> | blocked | stale-cache | partial (the source threw). */
export type SourceStatus = 'ok' | `degraded:${Tier}` | 'blocked' | 'stale-cache' | 'partial';

export interface SourceRunStats {
  status: SourceStatus;
  /** True for partial and blocked: the source gave us nothing trustworthy this run. */
  failed: boolean;
  error: string | null;
  tier: Tier | null;
  /** Entries on the listings before the seen-skip. This is what the low-source rule judges. */
  listed: number;
  /** Jobs the adapter returned (new or changed). */
  jobs: number;
  deferred: number;
  http_status: number | null;
  challenge: boolean;
  human_solved: boolean;
  stale_age_s: number | null;
  duration_s: number;
  /** The source stopped fetching details early (time budget or max_details); `truncated_left` wait for the next scan.
   *  Optional: status files written before this field existed lack it. */
  truncated?: boolean;
  truncated_reason?: 'time' | 'max_details' | null;
  truncated_left?: number;
  finished_at: string;
}

export interface ScanHistoryEntry {
  scan_id: string;
  started_at: string;
  finished_at: string;
  result: 'ok' | 'partial' | 'failed';
  sources: Record<string, SourceRunStats>;
}

export interface ScanStatusFile {
  updated_at: string;
  last_scan_id: string;
  last_result: 'ok' | 'partial' | 'failed';
  low_sources: string[];
  failed_sources: string[];
  sources: Record<string, SourceRunStats & { low: boolean; scan_id: string }>;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * "Low" sources: listed 0 entries, or under 30% of their own median over the last 7 runs that
 * included them (judged only once 3 such earlier runs exist). A failed source is reported as failed,
 * not low. A low source is treated as broken, never as a quiet day.
 */
export function lowSources(stats: Record<string, Pick<SourceRunStats, 'failed' | 'listed'>>, history: ScanHistoryEntry[]): string[] {
  const low: string[] = [];
  for (const [id, st] of Object.entries(stats)) {
    if (st.failed) continue;
    if (st.listed === 0) {
      low.push(id);
      continue;
    }
    const past = history
      .filter((h) => h.sources?.[id] && !h.sources[id].failed)
      .slice(-LOW_MEDIAN_RUNS)
      .map((h) => h.sources[id].listed);
    if (past.length < LOW_MIN_HISTORY) continue;
    const m = median(past);
    if (m > 0 && st.listed < LOW_FRACTION * m) low.push(id);
  }
  return low;
}

export function readHistory(ctx: Pick<Context, 'paths'>): ScanHistoryEntry[] {
  try {
    return fs
      .readFileSync(ctx.paths.scanHistoryFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ScanHistoryEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function readStatus(ctx: Pick<Context, 'paths'>): ScanStatusFile | null {
  try {
    return JSON.parse(fs.readFileSync(ctx.paths.scanStatusFile, 'utf8')) as ScanStatusFile;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // a reader never sees half a file
}

/**
 * Records one scan: computes low sources against the history BEFORE this run, then writes the status
 * file, appends the history (keeping 60) and inserts source_runs rows. Returns the low sources.
 */
export function recordScan(
  ctx: Pick<Context, 'paths' | 'db'>,
  entry: ScanHistoryEntry,
  log: (m: string) => void = () => {},
): { low_sources: string[] } {
  const history = readHistory(ctx);
  const low = lowSources(entry.sources, history);
  try {
    const prev = readStatus(ctx);
    const sources: ScanStatusFile['sources'] = { ...(prev?.sources ?? {}) };
    for (const [id, st] of Object.entries(entry.sources)) sources[id] = { ...st, low: low.includes(id), scan_id: entry.scan_id };
    const status: ScanStatusFile = {
      updated_at: entry.finished_at,
      last_scan_id: entry.scan_id,
      last_result: entry.result,
      low_sources: Object.entries(sources).filter(([, s]) => s.low).map(([id]) => id),
      failed_sources: Object.entries(sources).filter(([, s]) => s.failed).map(([id]) => id),
      sources,
    };
    writeAtomic(ctx.paths.scanStatusFile, `${JSON.stringify(status, null, 2)}\n`);
    writeAtomic(ctx.paths.scanHistoryFile, [...history, entry].slice(-HISTORY_KEEP).map((h) => JSON.stringify(h)).join('\n') + '\n');
  } catch (err) {
    log(`! could not write scan status: ${(err as Error).message}`);
  }
  try {
    const db = ctx.db();
    const ins = db.prepare(
      `INSERT INTO source_runs (source, started_at, tier, status, http_status, jobs_found, challenge, human_solved, error, scan_id, listed, deferred, duration_ms)
       VALUES (@source, @started_at, @tier, @status, @http_status, @jobs, @challenge, @human_solved, @error, @scan_id, @listed, @deferred, @duration_ms)`,
    );
    db.transaction(() => {
      for (const [source, st] of Object.entries(entry.sources)) {
        ins.run({
          source,
          started_at: entry.started_at,
          tier: st.tier,
          status: st.status,
          http_status: st.http_status,
          jobs: st.jobs,
          challenge: st.challenge ? 1 : 0,
          human_solved: st.human_solved ? 1 : 0,
          error: st.error,
          scan_id: entry.scan_id,
          listed: st.listed,
          deferred: st.deferred,
          duration_ms: Math.round(st.duration_s * 1000),
        });
      }
    })();
  } catch (err) {
    log(`! could not record source runs: ${(err as Error).message}`);
  }
  return { low_sources: low };
}
