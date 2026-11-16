import { z } from 'zod';
import type { Context } from '../context.ts';
import type { DB } from '../db/index.ts';
import { adText, jobsById, matchKey, type MatchJob } from './jobs.ts';
import { starsFromPoints, type StarBands } from './stars.ts';
import { containsQuote } from './text.ts';

/** Rubric dimensions and their weights (PRD §5.3). modes/score.md explains the anchors for each. */
export const DIMENSIONS = {
  role_fit: 25,
  must_haves: 30,
  seniority: 15,
  education: 10,
  location: 10,
  domain: 10,
} as const;
export type Dimension = keyof typeof DIMENSIONS;
export const WHY_MAX_WORDS = 20;

const dim = (max: number) => z.number().int(`whole points`).min(0).max(max, `at most ${max} points`);
const Str = (max: number) => z.string().trim().min(1).max(max);

export const RequirementSchema = z.object({
  text: Str(300),
  /** The phrase from the ad, copied exactly (case and spacing may differ). */
  jd_quote: Str(400),
  status: z.enum(['met', 'partial', 'missing']),
  mandatory: z.boolean().optional(),
});

export const ScoreItemSchema = z.object({
  job_id: Str(40),
  dimensions: z.object({
    role_fit: dim(DIMENSIONS.role_fit),
    must_haves: dim(DIMENSIONS.must_haves),
    seniority: dim(DIMENSIONS.seniority),
    education: dim(DIMENSIONS.education),
    location: dim(DIMENSIONS.location),
    domain: dim(DIMENSIONS.domain),
  }),
  requirements: z.array(RequirementSchema).max(40).default([]),
  matched: z.array(Str(200)).max(40).default([]),
  gaps: z.array(Str(200)).max(40).default([]),
  why: Str(300).refine((s) => s.split(/\s+/).filter(Boolean).length <= WHY_MAX_WORDS, `why is ${WHY_MAX_WORDS} words or fewer`),
  scam_signals: z.array(Str(300)).max(20).default([]),
  missing_mandatory: z.array(Str(300)).max(20).default([]),
  model: Str(100).optional(),
});
export type ScoreItem = z.infer<typeof ScoreItemSchema>;

export type CappedBy = 'scam' | 'missing_mandatory' | null;

export interface Derived {
  points: number;
  raw_stars: number;
  stars: number;
  capped_by: CappedBy;
  missing_mandatory: string[];
}

/** Points, stars and caps are computed here, never by the agent. */
export function derive(item: Pick<ScoreItem, 'dimensions' | 'requirements' | 'scam_signals' | 'missing_mandatory'>, bands: StarBands): Derived {
  const points = (Object.keys(DIMENSIONS) as Dimension[]).reduce((s, k) => s + item.dimensions[k], 0);
  const raw = starsFromPoints(points, bands);
  const missing = [
    ...new Set([...item.missing_mandatory, ...item.requirements.filter((r) => r.mandatory && r.status === 'missing').map((r) => r.text)]),
  ];
  let stars: number = raw;
  let capped: CappedBy = null;
  if (missing.length && stars > 2) {
    stars = 2;
    capped = 'missing_mandatory';
  }
  if (item.scam_signals.length) {
    // A scam signal always shows as capped by scam, even when the points were already low.
    stars = 1;
    capped = 'scam';
  }
  return { points, raw_stars: raw, stars, capped_by: capped, missing_mandatory: missing };
}

export interface SaveError {
  index: number;
  job_id: string | null;
  problems: string[];
}

/** Validates each item on its own; the valid ones are saved (upsert on job, resume, rubric). */
export function saveScores(ctx: Context, items: unknown[]) {
  const key = matchKey(ctx);
  const bands = ctx.config().settings.stars;
  const db = ctx.db();
  const errors: SaveError[] = [];
  const valid: { index: number; item: ScoreItem }[] = [];

  items.forEach((raw, index) => {
    const parsed = ScoreItemSchema.safeParse(raw);
    const jobId = typeof (raw as any)?.job_id === 'string' ? (raw as any).job_id : null;
    if (!parsed.success) {
      errors.push({ index, job_id: jobId, problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(item)'}: ${i.message}`) });
    } else valid.push({ index, item: parsed.data });
  });

  const jobs = jobsById(db, valid.map((v) => v.item.job_id));
  const seen = new Set<string>();
  const results: { job_id: string; points: number; stars: number; capped_by: CappedBy }[] = [];
  const upsert = db.prepare(
    `INSERT INTO scores (job_id, resume_hash, rubric_version, job_hash, points, stars, matched_json, gaps_json, breakdown_json, why, capped_by, model, created_at)
     VALUES (@job_id, @resume_hash, @rubric_version, @job_hash, @points, @stars, @matched_json, @gaps_json, @breakdown_json, @why, @capped_by, @model, @at)
     ON CONFLICT(job_id, resume_hash, rubric_version) DO UPDATE SET
       job_hash = excluded.job_hash, points = excluded.points, stars = excluded.stars, matched_json = excluded.matched_json,
       gaps_json = excluded.gaps_json, breakdown_json = excluded.breakdown_json, why = excluded.why,
       capped_by = excluded.capped_by, model = excluded.model, created_at = excluded.created_at`,
  );

  db.transaction(() => {
    for (const { index, item } of valid) {
      const job = jobs.get(item.job_id);
      const problems: string[] = [];
      if (!job) problems.push(`job_id: no job with id ${item.job_id}`);
      if (seen.has(item.job_id)) problems.push(`job_id: ${item.job_id} appears twice in this batch`);
      if (job) problems.push(...quoteProblems(item, job));
      if (problems.length) {
        errors.push({ index, job_id: item.job_id, problems });
        continue;
      }
      seen.add(item.job_id);
      const d = derive(item, bands);
      upsert.run({
        job_id: item.job_id,
        resume_hash: key.resume_hash,
        rubric_version: key.rubric_version,
        job_hash: job!.job_hash,
        points: d.points,
        stars: d.stars,
        matched_json: JSON.stringify(item.matched),
        gaps_json: JSON.stringify(item.gaps),
        breakdown_json: JSON.stringify({
          dimensions: item.dimensions,
          requirements: item.requirements,
          scam_signals: item.scam_signals,
          missing_mandatory: d.missing_mandatory,
          raw_stars: d.raw_stars,
        }),
        why: item.why,
        capped_by: d.capped_by,
        model: item.model ?? null,
        at: ctx.now().toISOString(),
      });
      results.push({ job_id: item.job_id, points: d.points, stars: d.stars, capped_by: d.capped_by });
    }
  })();

  errors.sort((a, b) => a.index - b.index);
  return { resume_hash: key.resume_hash, rubric_version: key.rubric_version, saved: results.length, failed: errors.length, results, errors };
}

function quoteProblems(item: ScoreItem, job: MatchJob): string[] {
  // An image ad has no text to check a quote against until the agent has read the image and saved what it
  // says (`slj jobs transcribe`). Scoring it unread would be a guess, so it is refused.
  if (job.is_image_ad && !job.ad_text) {
    return [
      `job ${job.id} is an image ad and its text has not been transcribed: read the image (image_urls in match prefilter), ` +
        `save exactly what it says with \`slj jobs transcribe ${job.id} --text "..."\`, then score it quoting that text`,
    ];
  }
  const text = `${job.title}\n${adText(job)}`;
  return item.requirements.flatMap((r, i) =>
    containsQuote(text, r.jd_quote) ? [] : [`requirements.${i}.jd_quote: "${r.jd_quote.slice(0, 80)}" is not in the job ad; copy the phrase exactly`],
  );
}

export interface StoredScore {
  job_id: string;
  resume_hash: string;
  rubric_version: string;
  job_hash: string | null;
  points: number;
  stars: number;
  matched: string[];
  gaps: string[];
  dimensions: Record<Dimension, number>;
  requirements: z.infer<typeof RequirementSchema>[];
  scam_signals: string[];
  missing_mandatory: string[];
  raw_stars: number;
  why: string | null;
  capped_by: CappedBy;
  model: string | null;
  created_at: string;
}

function toStored(r: Record<string, any>): StoredScore {
  const b = JSON.parse(r.breakdown_json ?? '{}');
  return {
    job_id: r.job_id,
    resume_hash: r.resume_hash,
    rubric_version: r.rubric_version,
    job_hash: r.job_hash ?? null,
    points: r.points,
    stars: r.stars,
    matched: JSON.parse(r.matched_json ?? '[]'),
    gaps: JSON.parse(r.gaps_json ?? '[]'),
    dimensions: b.dimensions ?? {},
    requirements: b.requirements ?? [],
    scam_signals: b.scam_signals ?? [],
    missing_mandatory: b.missing_mandatory ?? [],
    raw_stars: b.raw_stars ?? r.stars,
    why: r.why ?? null,
    capped_by: r.capped_by ?? null,
    model: r.model ?? null,
    created_at: r.created_at,
  };
}

export function getScore(db: DB, jobId: string, resumeHash: string, rubric: string): StoredScore | null {
  const r = db.prepare('SELECT * FROM scores WHERE job_id = ? AND resume_hash = ? AND rubric_version = ?').get(jobId, resumeHash, rubric);
  return r ? toStored(r as Record<string, any>) : null;
}

export function listScores(db: DB, resumeHash: string, rubric: string): StoredScore[] {
  return (db.prepare('SELECT * FROM scores WHERE resume_hash = ? AND rubric_version = ? ORDER BY job_id').all(resumeHash, rubric) as Record<string, any>[]).map(
    toStored,
  );
}
