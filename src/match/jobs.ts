import crypto from 'node:crypto';
import type { Context } from '../context.ts';
import type { DB } from '../db/index.ts';
import { resumeHash } from '../user/profile.ts';
import { colomboToday, districtKey, placeOf } from './deps.ts';

/** The job columns match needs. Read with match's own SQL so S2's store can change underneath. */
export interface MatchJob {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  district: string | null;
  remote: boolean;
  description: string;
  closing_date: string | null;
  posted_at: string | null;
  fetched_at: string;
  platform: string;
  source: string;
  /** The ad's page on the job site it came from. */
  source_url: string | null;
  apply_method: string;
  apply_url: string | null;
  apply_email: string | null;
  apply_phone: string | null;
  closed_at: string | null;
  /** The ad is a picture (topjobs, governmentjobs, many hotjobs/dreamjobs ads): the text is in the image. */
  is_image_ad: boolean;
  /** Links to the ad's image(s) or file(s), found in the description. */
  image_urls: string[];
  /** What the image says, as the agent transcribed it (`slj jobs transcribe`), or null. */
  ad_text: string | null;
  job_hash: string;
}

/** Everything the scorer may read and quote: the description plus the transcribed image text. */
export function adText(j: Pick<MatchJob, 'description' | 'ad_text'>): string {
  return j.ad_text ? `${j.description}\n\n${j.ad_text}` : j.description;
}

const IMAGE_URL = /https?:\/\/[^\s<>)"'\]]+/g;
/** Image or ad-file links in a description: .jpg/.png/.webp/.gif/.pdf, image-view pages and Google Drive files. */
export function imageUrls(description: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (description ?? '').matchAll(IMAGE_URL)) {
    const u = m[0].replace(/[.,;]+$/, '');
    if (/\.(jpe?g|png|webp|gif|pdf)(\?|#|$)/i.test(u) || /image-view\.php|drive\.google\.com|docs\.google\.com\/(file|document)/i.test(u)) out.push(u);
  }
  return [...new Set(out)];
}

const COLS = `id, title, company, location, district, remote, description, closing_date, posted_at, fetched_at, platform, source, source_url,
  apply_method, apply_url, apply_email, apply_phone, closed_at, is_image_ad, ad_text`;

/**
 * The text a score was given: title, company, location and description. If any of it changes the job is
 * re-scored. sha256, first 16 hex characters.
 */
export function jobHash(j: { title: string; company?: string | null; location?: string | null; description?: string | null; ad_text?: string | null }): string {
  const parts = [j.title, j.company ?? '', j.location ?? '', j.description ?? ''];
  // A transcribed image ad is new text to score: the score made before it (if any) is stale.
  if (j.ad_text) parts.push(j.ad_text);
  const text = parts.map((s) => s.replace(/\s+/g, ' ').trim()).join('\n');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function toMatchJob(r: Record<string, any>): MatchJob {
  const place = placeOf(r.location);
  return {
    id: r.id,
    title: r.title,
    company: r.company ?? null,
    location: r.location ?? null,
    district: r.district ? districtKey(String(r.district)) : place.district,
    remote: r.remote == null ? place.remote : !!r.remote,
    description: r.description ?? '',
    closing_date: r.closing_date ?? null,
    posted_at: r.posted_at ?? null,
    fetched_at: r.fetched_at,
    platform: r.platform,
    source: r.source,
    source_url: r.source_url ?? null,
    apply_method: r.apply_method,
    apply_url: r.apply_url ?? null,
    apply_email: r.apply_email ?? null,
    apply_phone: r.apply_phone ?? null,
    closed_at: r.closed_at ?? null,
    is_image_ad: !!r.is_image_ad,
    image_urls: r.is_image_ad ? imageUrls(r.description) : [],
    ad_text: r.ad_text ?? null,
    job_hash: jobHash({ title: r.title, company: r.company, location: r.location, description: r.description, ad_text: r.ad_text }),
  };
}

/** Open = not marked closed, and the closing date (Colombo) has not passed. Sorted by id for determinism. */
export function openJobs(db: DB, today: string): MatchJob[] {
  return (
    db
      .prepare(`SELECT ${COLS} FROM jobs WHERE closed_at IS NULL AND (closing_date IS NULL OR closing_date >= ?) ORDER BY id`)
      .all(today) as Record<string, any>[]
  ).map(toMatchJob);
}

export function jobsById(db: DB, ids: string[]): Map<string, MatchJob> {
  const out = new Map<string, MatchJob>();
  if (!ids.length) return out;
  const stmt = db.prepare(`SELECT ${COLS} FROM jobs WHERE id = ?`);
  for (const id of new Set(ids)) {
    const r = stmt.get(id) as Record<string, any> | undefined;
    if (r) out.set(id, toMatchJob(r));
  }
  return out;
}

export function isOpen(j: Pick<MatchJob, 'closed_at' | 'closing_date'>, today: string): boolean {
  return !j.closed_at && (!j.closing_date || j.closing_date >= today);
}

/** The key every cached score and every daily report hangs on. */
export interface MatchKey {
  resume_hash: string;
  rubric_version: string;
  today: string;
}

export function matchKey(ctx: Context): MatchKey {
  return { resume_hash: resumeHash(ctx), rubric_version: ctx.config().settings.rubric_version, today: colomboToday(ctx.now()) };
}

/** Score rows for this resume and rubric whose job text has not changed since: job_id → stored job_hash. */
export function freshScoreHashes(db: DB, key: Pick<MatchKey, 'resume_hash' | 'rubric_version'>): Map<string, string | null> {
  const rows = db
    .prepare('SELECT job_id, job_hash FROM scores WHERE resume_hash = ? AND rubric_version = ?')
    .all(key.resume_hash, key.rubric_version) as { job_id: string; job_hash: string | null }[];
  return new Map(rows.map((r) => [r.job_id, r.job_hash]));
}
