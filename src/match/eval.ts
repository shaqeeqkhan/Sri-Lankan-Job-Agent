import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { jobsById, matchKey } from './jobs.ts';
import { getScore } from './score-store.ts';

/**
 * M2 gate harness (PRD §4 goal 2, §11): compare saved stars with a recruiter's labels.
 *
 * Labels file, CSV (`.csv`, `.txt`):
 *   job_id,human_stars[,note]
 *   j3f9a1c2,4,clear fit
 *   # lines starting with # are comments; the header line is optional
 * or JSON (`.json`): [{ "job_id": "j3f9a1c2", "human_stars": 4 }, ...]
 *
 * The labels are for one CV: scores are read for the current user/resume.md (or `resume_hash`) and rubric.
 * Pass mark: at least 85% within ±1 star, over at least 30 labelled jobs.
 */
export const PASS_SHARE = 0.85;
export const MIN_LABELS = 30;

export interface Label {
  job_id: string;
  human_stars: number;
}

export function parseLabels(text: string, ext: string): Label[] {
  let rows: { job_id: unknown; human_stars: unknown }[];
  if (ext === '.json') {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) throw new SljError('INVALID_INPUT', 'A JSON labels file is a list of { job_id, human_stars }.');
    rows = raw;
  } else {
    rows = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
      .filter((c) => !(c[0].toLowerCase() === 'job_id'))
      .map((c) => ({ job_id: c[0], human_stars: c[1] }));
  }
  return rows.map((r, i) => {
    const stars = Number(r.human_stars);
    if (typeof r.job_id !== 'string' || !r.job_id || !Number.isInteger(stars) || stars < 1 || stars > 5) {
      throw new SljError('INVALID_INPUT', `Label ${i + 1} is not "job_id, human_stars (1-5)": ${JSON.stringify(r)}`);
    }
    return { job_id: r.job_id, human_stars: stars };
  });
}

export function evaluate(ctx: Context, input: { labels: string; resume_hash?: string }) {
  const file = path.resolve(input.labels);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new SljError('NOT_FOUND', `No labels file at ${file}.`);
  }
  const labels = parseLabels(text, path.extname(file).toLowerCase());
  const rubric = ctx.config().settings.rubric_version;
  const resumeHash = input.resume_hash ?? matchKey(ctx).resume_hash;
  const db = ctx.db();
  const jobs = jobsById(db, labels.map((l) => l.job_id));

  const compared: { job_id: string; title: string | null; human: number; agent: number; diff: number; points: number }[] = [];
  const unscored: string[] = [];
  for (const l of labels) {
    const s = getScore(db, l.job_id, resumeHash, rubric);
    if (!s) {
      unscored.push(l.job_id);
      continue;
    }
    compared.push({ job_id: l.job_id, title: jobs.get(l.job_id)?.title ?? null, human: l.human_stars, agent: s.stars, diff: s.stars - l.human_stars, points: s.points });
  }
  const within = compared.filter((c) => Math.abs(c.diff) <= 1).length;
  const exact = compared.filter((c) => c.diff === 0).length;
  const share = compared.length ? Math.round((within / compared.length) * 1000) / 1000 : 0;
  return {
    labels_file: file,
    resume_hash: resumeHash,
    rubric_version: rubric,
    labelled: labels.length,
    compared: compared.length,
    unscored,
    within_1: within,
    within_1_share: share,
    exact_share: compared.length ? Math.round((exact / compared.length) * 1000) / 1000 : 0,
    mean_abs_diff: compared.length ? Math.round((compared.reduce((s, c) => s + Math.abs(c.diff), 0) / compared.length) * 100) / 100 : null,
    pass: compared.length >= MIN_LABELS && share >= PASS_SHARE,
    pass_rule: `at least ${PASS_SHARE * 100}% within ±1 star over at least ${MIN_LABELS} labelled jobs`,
    misses: compared.filter((c) => Math.abs(c.diff) > 1).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.job_id.localeCompare(b.job_id)),
  };
}
