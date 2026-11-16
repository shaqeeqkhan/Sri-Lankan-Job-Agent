import crypto from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';

type PathsCtx = Pick<Context, 'paths'>;

// ---------------------------------------------------------------- resume.md

/** The text of user/resume.md. Throws NO_RESUME when it is missing. */
export function readResume(ctx: PathsCtx): string {
  return readResumeBytes(ctx).toString('utf8');
}

function readResumeBytes(ctx: PathsCtx): Buffer {
  try {
    return fs.readFileSync(ctx.paths.resumeFile);
  } catch {
    throw new SljError('NO_RESUME', 'There is no user/resume.md yet. Import a CV first with `slj resume import <file>`.', {
      path: ctx.paths.resumeFile,
    });
  }
}

/** sha256 of user/resume.md's bytes, first 16 hex characters. Scores are keyed by it. */
export function resumeHash(ctx: PathsCtx): string {
  return crypto.createHash('sha256').update(readResumeBytes(ctx)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- profile.yml

/** Every profile field records whether the agent inferred it from the CV or the person said it. */
const field = <T extends z.ZodType>(value: T) => z.object({ value, inferred: z.boolean() });

export const SENIORITIES = ['intern', 'junior', 'mid', 'senior', 'lead', 'manager', 'executive'] as const;
export const WORK_MODES = ['any', 'onsite', 'hybrid', 'remote'] as const;

const Str = z.string().trim().min(1).max(200);

export const ProfileSchema = z.object({
  name: field(Str),
  target_titles: field(z.array(Str).min(1).max(3)),
  adjacent_titles: field(z.array(Str).max(20)),
  seniority: field(z.enum(SENIORITIES)),
  years_experience: field(z.number().min(0).max(60).nullable()),
  skills: field(z.array(Str).max(200)),
  location: field(Str.nullable()),
  districts_ok: field(z.array(Str).max(25)),
  work_mode: field(z.enum(WORK_MODES)),
  /** Monthly LKR. Optional. */
  salary_floor: field(z.number().int().min(0).nullable()).optional(),
  cv_style: field(z.enum(['modern', 'traditional'])),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Reads user/profile.yml. Throws NO_RESUME when user/resume.md is missing (the profile is derived from it),
 * and NO_PROFILE when profile.yml is missing or does not validate (details.problems lists why).
 */
export function loadProfile(ctx: PathsCtx): Profile {
  if (!fs.existsSync(ctx.paths.resumeFile)) readResumeBytes(ctx);
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(ctx.paths.profileFile, 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new SljError(
      'NO_PROFILE',
      missing
        ? 'There is no user/profile.yml yet. Read user/resume.md and write it (modes/import.md).'
        : `user/profile.yml is not valid YAML: ${(err as Error).message}`,
      { path: ctx.paths.profileFile },
    );
  }
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`);
    throw new SljError('NO_PROFILE', `user/profile.yml is invalid: ${problems.join('; ')}`, { path: ctx.paths.profileFile, problems });
  }
  return parsed.data;
}

// ---------------------------------------------------------------- facts.yml

export const FactSchema = z.object({
  id: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(2000),
  /** e.g. metric, tool, scope, education, referee, personal */
  kind: z.string().trim().min(1).max(40),
  source: z.literal('interview'),
  confirmed: z.literal(true),
  added_at: z.string().min(1).max(40),
});
/** user/facts.yml is a YAML list of facts. */
export const FactsSchema = z.array(FactSchema).superRefine((facts, c) => {
  const ids = new Set<string>();
  for (const f of facts) {
    if (ids.has(f.id)) c.addIssue({ code: 'custom', message: `duplicate fact id "${f.id}"` });
    ids.add(f.id);
  }
});
export type Fact = z.infer<typeof FactSchema>;

/** Reads user/facts.yml. A missing or empty file is no facts; an invalid one throws INVALID_INPUT. */
export function loadFacts(ctx: PathsCtx): Fact[] {
  let text: string;
  try {
    text = fs.readFileSync(ctx.paths.factsFile, 'utf8');
  } catch {
    return [];
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text) ?? [];
  } catch (err) {
    throw new SljError('INVALID_INPUT', `user/facts.yml is not valid YAML: ${(err as Error).message}`, { path: ctx.paths.factsFile });
  }
  const parsed = FactsSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`);
    throw new SljError('INVALID_INPUT', `user/facts.yml is invalid: ${problems.join('; ')}`, { path: ctx.paths.factsFile, problems });
  }
  return parsed.data;
}

// ---------------------------------------------------------------- stats.json

export type StatKey = 'scans' | 'top_reports' | 'cvs';
export interface Stats {
  scans: number;
  top_reports: number;
  cvs: number;
  updated_at: string | null;
}

/** Adds one to a local counter in user/stats.json. Never uploaded anywhere. Returns the new counts. */
export function bumpStat(ctx: Pick<Context, 'paths' | 'now'>, key: StatKey): Stats {
  const stats: Stats = { scans: 0, top_reports: 0, cvs: 0, updated_at: null };
  try {
    const raw = JSON.parse(fs.readFileSync(ctx.paths.statsFile, 'utf8')) as Partial<Stats>;
    for (const k of ['scans', 'top_reports', 'cvs'] as const) {
      if (Number.isInteger(raw[k]) && (raw[k] as number) >= 0) stats[k] = raw[k] as number;
    }
  } catch {
    // Missing or unreadable counters start again at zero; they are informational only.
  }
  stats[key] += 1;
  stats.updated_at = ctx.now().toISOString();
  fs.mkdirSync(ctx.paths.userDir, { recursive: true });
  fs.writeFileSync(ctx.paths.statsFile, `${JSON.stringify(stats, null, 2)}\n`);
  return stats;
}
