import crypto from 'node:crypto';
import type { DB } from '../db/index.ts';
import { identityKeys, tier2Prefix, type IdentityKeys } from './identity.ts';
import { canonicalUrl, jobHash, shortId } from './normalize.ts';
import { parsePlace } from './places.ts';
import type { ApplyMethod, JobFields, JobRow } from './schema.ts';

/** Closing dates are Sri Lankan dates, so "today" is today in Colombo. */
export function colomboToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(now);
}

export interface SourceRef {
  source: string;
  /** Stable id of the job within that source: the site's posting id, canonical URL, or a content hash. */
  source_ref: string;
  source_url?: string | null;
}

export interface StoreInput extends Omit<JobFields, 'apply_method'> {
  apply_method: ApplyMethod;
  platform: string;
  image_path?: string | null;
  review_reasons?: string[];
}

export interface UpsertOptions {
  /**
   * Source ids in precedence order (config/sources.yml order). When a copy arrives from a source
   * listed before the one that owns the stored row, it takes the row over and its values win;
   * a copy from a later source only fills nulls. Sources not listed (e.g. "manual") come last.
   */
  precedence?: readonly string[];
}

export type UpsertOutcome = 'inserted' | 'merged' | 'unchanged';
export type MatchedBy = 'source' | 'tier1' | 'tier1b' | 'tier2' | 'tier2_place' | 'source_url';

/** A repost with a different closing date counts as a new job once the old one is this old (tier 2 only). */
const REPOST_AFTER_DAYS = 60;

const SCALAR_FIELDS = [
  'company', 'location', 'category', 'salary_text', 'closing_date', 'apply_url', 'apply_email', 'apply_phone',
  'apply_instructions', 'subject_instruction', 'posted_at', 'image_path', 'description',
  'external_id', 'country_code', 'employment_type', 'scraped_at',
] as const;

function keysFor(input: StoreInput): IdentityKeys {
  return identityKeys({
    platform: input.platform,
    external_id: input.external_id,
    company: input.company,
    title: input.title,
    location: input.location,
    apply_url: input.apply_url,
    apply_email: input.apply_email,
    apply_phone: input.apply_phone,
  });
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The stored job this input duplicates, strongest evidence first: the same source's own ref, then
 * identity tier 1, 1b, 2. A tier 2 key without a place matches a stored copy that names one (and the
 * other way round) only when exactly one candidate exists.
 */
export function findDuplicate(
  db: DB,
  keys: IdentityKeys,
  src: SourceRef | null,
  closingDate: string | null | undefined,
  now: Date,
): { row: JobRow; by: MatchedBy } | undefined {
  if (src) {
    const bySource = db
      .prepare('SELECT j.* FROM job_sources s JOIN jobs j ON j.id = s.job_id WHERE s.source = ? AND s.source_ref = ?')
      .get(src.source, src.source_ref) as JobRow | undefined;
    if (bySource) return { row: bySource, by: 'source' };
  }
  if (keys.tier1) {
    const r = db.prepare('SELECT * FROM jobs WHERE identity_t1 = ? ORDER BY fetched_at LIMIT 1').get(keys.tier1) as JobRow | undefined;
    if (r) return { row: r, by: 'tier1' };
  }
  if (keys.tier1b) {
    const r = db.prepare('SELECT * FROM jobs WHERE identity_t1b = ? ORDER BY fetched_at LIMIT 1').get(keys.tier1b) as JobRow | undefined;
    if (r) return { row: r, by: 'tier1b' };
  }
  if (keys.tier2) {
    const cutoff = new Date(now.getTime() - REPOST_AFTER_DAYS * 86_400_000).toISOString();
    const notRepost = `(closing_date IS NULL OR @closing IS NULL OR closing_date = @closing OR fetched_at >= @cutoff)`;
    const p = { closing: closingDate ?? null, cutoff };
    const exact = db
      .prepare(`SELECT * FROM jobs WHERE identity_t2 = @key AND ${notRepost} ORDER BY fetched_at DESC LIMIT 1`)
      .get({ ...p, key: keys.tier2 }) as JobRow | undefined;
    if (exact) return { row: exact, by: 'tier2' };
    const prefix = tier2Prefix(keys.tier2);
    const placeless = keys.tier2 === prefix;
    const rows = (
      placeless
        ? db.prepare(`SELECT * FROM jobs WHERE identity_t2 LIKE @like ESCAPE '\\' AND ${notRepost} LIMIT 2`).all({ ...p, like: `${likeEscape(prefix)}%` })
        : db.prepare(`SELECT * FROM jobs WHERE identity_t2 = @key AND ${notRepost} LIMIT 2`).all({ ...p, key: prefix })
    ) as JobRow[];
    if (rows.length === 1) return { row: rows[0], by: 'tier2_place' };
  }
  const url = canonicalUrl(src?.source_url);
  if (url) {
    const byUrl = db
      .prepare('SELECT j.* FROM job_sources s JOIN jobs j ON j.id = s.job_id WHERE s.source_url = ? LIMIT 1')
      .get(url) as JobRow | undefined;
    if (byUrl) return { row: byUrl, by: 'source_url' };
  }
  return undefined;
}

function union(a: string, b: string[] | null | undefined): string {
  return JSON.stringify([...new Set([...(JSON.parse(a) as string[]), ...(b ?? [])])]);
}

function rankIn(precedence: readonly string[] | undefined, source: string): number {
  const i = precedence?.indexOf(source) ?? -1;
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * Insert a job, or merge it into the job it duplicates (identity tiers, strongest first).
 * The source that owns the row, and any source ahead of it in precedence, may overwrite values;
 * any other copy is recorded in job_sources and only fills fields that are still empty.
 */
export function upsertJob(
  db: DB,
  input: StoreInput,
  src: SourceRef,
  now: Date,
  opts: UpsertOptions = {},
): { id: string; outcome: UpsertOutcome; matched_by: MatchedBy | null } {
  const at = now.toISOString();
  const today = colomboToday(now);
  const hash = jobHash(input, src.source_ref);
  const sourceUrl = canonicalUrl(src.source_url);
  const values = { ...input, apply_url: canonicalUrl(input.apply_url) };
  const place = parsePlace(values.location);
  // A parsed value only fills a null (rule 9).
  if (values.remote == null && place.remote) values.remote = true;
  const keys = keysFor(values);

  return db.transaction(() => {
    const existing = findDuplicate(db, keys, src, values.closing_date, now);
    let id: string;
    let outcome: UpsertOutcome;

    if (!existing) {
      id = shortId(`${src.source}|${src.source_ref}`);
      while (db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id)) id = shortId(`${id}+`);
      db.prepare(
        `INSERT INTO jobs (id, source, source_url, platform, title, company, location, category, salary_text, description,
           closing_date, apply_method, apply_url, apply_email, apply_phone, apply_instructions, subject_instruction,
           required_docs, is_image_ad, image_path, needs_review, review_reasons, posted_at, fetched_at, updated_at, hash,
           external_id, country_code, remote, employment_type, scraped_at, district, identity_t1, identity_t1b, identity_t2)
         VALUES (@id, @source, @source_url, @platform, @title, @company, @location, @category, @salary_text, @description,
           @closing_date, @apply_method, @apply_url, @apply_email, @apply_phone, @apply_instructions, @subject_instruction,
           @required_docs, @is_image_ad, @image_path, @needs_review, @review_reasons, @posted_at, @at, @at, @hash,
           @external_id, @country_code, @remote, @employment_type, @scraped_at, @district, @t1, @t1b, @t2)`,
      ).run({
        id,
        source: src.source,
        source_url: sourceUrl,
        platform: values.platform,
        title: values.title,
        apply_method: values.apply_method,
        required_docs: JSON.stringify(values.required_docs ?? []),
        is_image_ad: values.is_image_ad ? 1 : 0,
        needs_review: values.review_reasons?.length ? 1 : 0,
        review_reasons: JSON.stringify(values.review_reasons ?? []),
        remote: values.remote == null ? null : values.remote ? 1 : 0,
        ...Object.fromEntries(SCALAR_FIELDS.map((f) => [f, values[f] ?? null])),
        district: place.district,
        t1: keys.tier1,
        t1b: keys.tier1b,
        t2: keys.tier2,
        at,
        hash,
      });
      outcome = 'inserted';
    } else {
      const row = existing.row;
      id = row.id;
      const sameSource = existing.by === 'source' || row.source === src.source;
      const takeover = !sameSource && rankIn(opts.precedence, src.source) < rankIn(opts.precedence, row.source);
      const owns = sameSource || takeover;
      const patch: Record<string, unknown> = {};
      for (const f of SCALAR_FIELDS) {
        const next = values[f];
        if (next == null || next === row[f]) continue;
        if (owns || row[f] == null) patch[f] = next;
      }
      if (owns && values.title !== row.title) patch.title = values.title;
      if (row.apply_method === 'unknown' && values.apply_method !== 'unknown') patch.apply_method = values.apply_method;
      if (owns && values.apply_method !== 'unknown' && values.apply_method !== row.apply_method) patch.apply_method = values.apply_method;
      if ((row.platform === 'other' && values.platform !== 'other') || (takeover && values.platform !== row.platform)) {
        patch.platform = values.platform;
      }
      if (takeover) {
        patch.source = src.source;
        if (sourceUrl) patch.source_url = sourceUrl;
      }
      const docs = union(row.required_docs, values.required_docs);
      if (docs !== row.required_docs) patch.required_docs = docs;
      const reasons = union(row.review_reasons, values.review_reasons);
      if (reasons !== row.review_reasons) {
        patch.review_reasons = reasons;
        patch.needs_review = 1;
      }
      if (values.is_image_ad && !row.is_image_ad) patch.is_image_ad = 1;
      if (values.remote != null && (owns || row.remote == null)) {
        const r = values.remote ? 1 : 0;
        if (r !== row.remote) patch.remote = r;
      }
      // Identity and district follow the merged values; a key already stored is kept unless this
      // copy owns the row (so every earlier copy still finds it).
      const merged = { ...row, ...patch } as JobRow;
      const mk = identityKeys({
        platform: merged.platform,
        external_id: merged.external_id,
        company: merged.company,
        title: merged.title,
        location: merged.location,
        apply_url: merged.apply_url,
        apply_email: merged.apply_email,
        apply_phone: merged.apply_phone,
      });
      const district = parsePlace(merged.location).district;
      const idPatch: Record<string, string | null> = {
        identity_t1: owns ? row.identity_t1 ?? mk.tier1 : row.identity_t1 ?? keys.tier1,
        identity_t1b: owns ? mk.tier1b ?? row.identity_t1b : row.identity_t1b ?? keys.tier1b,
        identity_t2: owns ? mk.tier2 ?? row.identity_t2 : row.identity_t2 ?? keys.tier2,
        district: owns ? district ?? row.district : row.district ?? district,
      };
      for (const [k, v] of Object.entries(idPatch)) if (v !== row[k as keyof JobRow]) patch[k] = v;
      // A closing date pushed back reopens a job that was closed only because its date had passed.
      const closing = (patch.closing_date as string | undefined) ?? row.closing_date;
      if (row.closed_at && row.closed_reason === 'closing_date_passed' && closing && closing >= today) {
        patch.closed_at = null;
        patch.closed_reason = null;
      }

      const visible = Object.keys(patch).filter((k) => !k.startsWith('identity_'));
      if (Object.keys(patch).length) {
        const sets = Object.keys(patch).map((k) => `${k} = @${k}`);
        db.prepare(`UPDATE jobs SET ${sets.join(', ')}${visible.length ? ', updated_at = @at' : ''} WHERE id = @id`).run({ ...patch, at, id });
      }
      outcome = visible.length || !sameSource ? 'merged' : 'unchanged';
    }

    db.prepare(
      `INSERT INTO job_sources (job_id, source, source_ref, source_url, seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source, source_ref) DO UPDATE SET seen_at = excluded.seen_at, source_url = COALESCE(excluded.source_url, source_url)`,
    ).run(id, src.source, src.source_ref, sourceUrl, at);
    return { id, outcome, matched_by: existing?.by ?? null };
  })();
}

/** Marks open jobs whose closing date (a Colombo date) is before `today` as closed. Returns how many. */
export function closePassedJobs(db: DB, now: Date): number {
  return db
    .prepare(
      `UPDATE jobs SET closed_at = @at, closed_reason = 'closing_date_passed'
        WHERE closed_at IS NULL AND closing_date IS NOT NULL AND closing_date < @today`,
    )
    .run({ at: now.toISOString(), today: colomboToday(now) }).changes;
}

export function closeJob(db: DB, id: string, reason: string, now: Date): boolean {
  return (
    db.prepare('UPDATE jobs SET closed_at = ?, closed_reason = ? WHERE id = ? AND closed_at IS NULL').run(now.toISOString(), reason, id)
      .changes > 0
  );
}

/** Open = not closed, and no closing date before today. */
export function countOpenJobs(db: DB, now: Date): number {
  return db
    .prepare('SELECT COUNT(*) FROM jobs WHERE closed_at IS NULL AND (closing_date IS NULL OR closing_date >= ?)')
    .pluck()
    .get(colomboToday(now)) as number;
}

// ---------------------------------------------------------------- seen

/** `seen.identity_hash` for a source's external id. */
export function seenHash(externalId: string): string {
  return crypto.createHash('sha256').update(externalId.trim()).digest('hex').slice(0, 32);
}

/** Every seen hash for one source, for a synchronous `ctx.seen(externalId)`. */
export function loadSeen(db: DB, source: string): Set<string> {
  return new Set(db.prepare('SELECT identity_hash FROM seen WHERE source = ?').pluck().all(source) as string[]);
}

export function markSeen(db: DB, source: string, externalId: string, now: Date): void {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO seen (identity_hash, source, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(source, identity_hash) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(seenHash(externalId), source, at, at);
}

/**
 * Identity keys of jobs already stored for these external ids of `source` (via job_sources or
 * tier 1), so a deferred job's cross-source copies can be held back by every key it is known by.
 */
export function storedKeysFor(db: DB, source: string, externalIds: string[]): string[] {
  const out = new Set<string>();
  const bySource = db.prepare('SELECT j.identity_t1, j.identity_t1b, j.identity_t2 FROM job_sources s JOIN jobs j ON j.id = s.job_id WHERE s.source = ? AND s.source_ref = ?');
  const byT1 = db.prepare('SELECT identity_t1, identity_t1b, identity_t2 FROM jobs WHERE identity_t1 = ?');
  for (const ext of externalIds) {
    const rows = [...(bySource.all(source, ext) as Record<string, string | null>[]), ...(byT1.all(`${source}|${ext}`) as Record<string, string | null>[])];
    for (const r of rows) for (const v of Object.values(r)) if (v) out.add(v);
  }
  return [...out];
}

export interface Job {
  id: string;
  source: string;
  source_url: string | null;
  platform: string;
  title: string;
  company: string | null;
  location: string | null;
  category: string | null;
  salary_text: string | null;
  closing_date: string | null;
  apply_method: ApplyMethod;
  apply_url: string | null;
  apply_email: string | null;
  apply_phone: string | null;
  apply_instructions: string | null;
  subject_instruction: string | null;
  required_docs: string[];
  is_image_ad: boolean;
  image_path: string | null;
  needs_review: boolean;
  review_reasons: string[];
  posted_at: string | null;
  fetched_at: string;
  updated_at: string;
  external_id: string | null;
  country_code: string | null;
  remote: boolean | null;
  employment_type: string | null;
  scraped_at: string | null;
  district: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  description?: string | null;
}

export function toJob(row: JobRow, withDescription: boolean): Job {
  const { hash: _hash, description, identity_t1: _t1, identity_t1b: _t1b, identity_t2: _t2, ...rest } = row;
  return {
    ...rest,
    required_docs: JSON.parse(row.required_docs),
    review_reasons: JSON.parse(row.review_reasons),
    is_image_ad: !!row.is_image_ad,
    needs_review: !!row.needs_review,
    remote: row.remote == null ? null : !!row.remote,
    ...(withDescription ? { description } : {}),
  };
}

export function getJob(db: DB, id: string) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!row) return undefined;
  const sources = db
    .prepare('SELECT source, source_ref, source_url, seen_at FROM job_sources WHERE job_id = ? ORDER BY seen_at')
    .all(id);
  return { ...toJob(row, true), sources, score: latestScore(db, id) };
}

function latestScore(db: DB, jobId: string) {
  const s = db
    .prepare('SELECT points, stars, why, capped_by, resume_hash, rubric_version, created_at FROM scores WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId) as Record<string, unknown> | undefined;
  return s ?? null;
}

export interface ListFilters {
  q?: string;
  platform?: string;
  apply_method?: ApplyMethod;
  location?: string;
  district?: string;
  category?: string;
  source?: string;
  since?: string;
  include_closed: boolean;
  closing_within_days?: number;
  needs_review?: boolean;
  min_stars?: number;
  sort: 'closing' | 'newest' | 'score';
  limit: number;
  offset: number;
}

export function listJobs(db: DB, f: ListFilters, today: string) {
  const where: string[] = [];
  const params: Record<string, unknown> = { today };
  if (!f.include_closed) where.push('j.closed_at IS NULL AND (j.closing_date IS NULL OR j.closing_date >= @today)');
  if (f.q) {
    where.push("(j.title LIKE @q ESCAPE '\\' OR j.company LIKE @q ESCAPE '\\' OR j.description LIKE @q ESCAPE '\\')");
    params.q = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  for (const key of ['platform', 'apply_method', 'source'] as const) {
    if (f[key]) {
      where.push(`j.${key} = @${key}`);
      params[key] = f[key];
    }
  }
  if (f.district) {
    where.push('j.district = @district COLLATE NOCASE');
    params.district = f.district;
  }
  for (const key of ['location', 'category'] as const) {
    if (f[key]) {
      where.push(`j.${key} LIKE @${key}`);
      params[key] = `%${f[key]}%`;
    }
  }
  if (f.since) {
    where.push('j.fetched_at >= @since');
    params.since = f.since;
  }
  if (f.closing_within_days != null) {
    where.push('j.closing_date IS NOT NULL AND j.closing_date <= @closing_limit');
    params.closing_limit = new Date(Date.parse(today) + f.closing_within_days * 86_400_000).toISOString().slice(0, 10);
  }
  if (f.needs_review != null) where.push(`j.needs_review = ${f.needs_review ? 1 : 0}`);
  if (f.min_stars != null) {
    where.push('s.stars >= @min_stars');
    params.min_stars = f.min_stars;
  }

  const from = `FROM jobs j LEFT JOIN (
      SELECT job_id, stars, points, MAX(id) FROM scores GROUP BY job_id
    ) s ON s.job_id = j.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const order = {
    closing: 'j.closing_date IS NULL, j.closing_date ASC, j.fetched_at DESC',
    newest: 'j.fetched_at DESC',
    score: 's.points IS NULL, s.points DESC, j.closing_date ASC',
  }[f.sort];

  const total = db.prepare(`SELECT COUNT(*) ${from}`).pluck().get(params) as number;
  const rows = db
    .prepare(`SELECT j.*, s.stars AS stars, s.points AS points ${from} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: f.limit, offset: f.offset }) as (JobRow & { stars: number | null; points: number | null })[];

  return {
    total,
    jobs: rows.map(({ stars, points, ...row }) => ({ ...toJob(row, false), stars, points })),
  };
}
