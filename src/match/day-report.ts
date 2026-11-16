import type { DB } from '../db/index.ts';
import { SljError } from '../errors.ts';
import type { MatchKey } from './jobs.ts';

/**
 * One row of `top_reports` per (resume_hash, report_date): the day's fixed numbering. `numbered[n - 1]` is the
 * job id behind "#n" all day, so "CV for #34" keeps working after later pages and variants.
 */
export interface DayReport {
  id: number | null;
  resume_hash: string;
  report_date: string;
  rubric_version: string;
  numbered: string[];
  /** Sections of the report file, in the order they were shown. */
  pages: { label: string | null; numbers: number[] }[];
  summary: string | null;
  /** Widening steps already taken today (PRD §5.4a step 3): adjacent, since:30d, since:60d, nearby_remote, slow_sources. */
  widened: string[];
  pool_size: number | null;
  created_at: string | null;
}

export function loadDayReport(db: DB, key: MatchKey): DayReport {
  const row = db
    .prepare('SELECT * FROM top_reports WHERE resume_hash = ? AND report_date = ? ORDER BY id DESC LIMIT 1')
    .get(key.resume_hash, key.today) as Record<string, any> | undefined;
  if (!row) {
    return {
      id: null, resume_hash: key.resume_hash, report_date: key.today, rubric_version: key.rubric_version,
      numbered: [], pages: [], summary: null, widened: [], pool_size: null, created_at: null,
    };
  }
  return {
    id: row.id,
    resume_hash: row.resume_hash,
    report_date: row.report_date,
    rubric_version: row.rubric_version ?? key.rubric_version,
    numbered: JSON.parse(row.job_ids_json ?? '[]'),
    pages: JSON.parse(row.pages_json ?? '[]'),
    summary: row.summary ?? null,
    widened: JSON.parse(row.widened_json ?? '[]'),
    pool_size: row.pool_size ?? null,
    created_at: row.created_at,
  };
}

export function saveDayReport(db: DB, r: DayReport, now: Date): DayReport {
  const at = now.toISOString();
  const params = {
    resume_hash: r.resume_hash,
    report_date: r.report_date,
    rubric_version: r.rubric_version,
    job_ids_json: JSON.stringify(r.numbered),
    pages_json: JSON.stringify(r.pages),
    summary: r.summary,
    widened_json: JSON.stringify(r.widened),
    pool_size: r.pool_size,
    at,
  };
  if (r.id == null) {
    const info = db
      .prepare(
        `INSERT INTO top_reports (resume_hash, report_date, rubric_version, created_at, updated_at, job_ids_json, pages_json, summary, widened_json, pool_size)
         VALUES (@resume_hash, @report_date, @rubric_version, @at, @at, @job_ids_json, @pages_json, @summary, @widened_json, @pool_size)`,
      )
      .run(params);
    return { ...r, id: Number(info.lastInsertRowid), created_at: at };
  }
  db.prepare(
    `UPDATE top_reports SET rubric_version = @rubric_version, updated_at = @at, job_ids_json = @job_ids_json, pages_json = @pages_json,
       summary = @summary, widened_json = @widened_json, pool_size = @pool_size WHERE id = @id`,
  ).run({ ...params, id: r.id });
  return r;
}

/** Adds widening steps to today's report (creating the row if needed). */
export function recordWidening(db: DB, key: MatchKey, steps: string[], now: Date): string[] {
  const r = loadDayReport(db, key);
  const next = [...new Set([...r.widened, ...steps])];
  if (next.length !== r.widened.length) saveDayReport(db, { ...r, widened: next }, now);
  return next;
}

/** "#34", "34" or 34 → 34. */
export function parseNumber(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) throw new SljError('INVALID_INPUT', `"${raw}" is not a report number like #7.`);
  return n;
}

/** The job id behind #n in today's report. */
export function resolveNumber(r: DayReport, raw: string | number): string {
  const n = parseNumber(raw);
  if (!r.numbered.length) {
    throw new SljError('NOT_FOUND', `There is no top report for today (${r.report_date}) yet, so #${n} means nothing. Run \`slj top\` first.`);
  }
  const id = r.numbered[n - 1];
  if (!id) throw new SljError('NOT_FOUND', `Today's report only goes up to #${r.numbered.length}; there is no #${n}. Say "more jobs" to number more.`);
  return id;
}

/** A job id, or "#n" resolved through today's report. */
export function jobRef(db: DB, key: MatchKey, ref: string): string {
  const s = ref.trim();
  if (/^#?\d+$/.test(s) && (s.startsWith('#') || !db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(s))) {
    return resolveNumber(loadDayReport(db, key), s);
  }
  if (!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(s)) throw new SljError('NOT_FOUND', `No job with id ${s}.`);
  return s;
}
