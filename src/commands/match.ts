import { z } from 'zod';
import { defineCommand, type Command } from '../registry.ts';
import { evaluate } from '../match/eval.ts';
import { matchKey } from '../match/jobs.ts';
import { prefilter } from '../match/prefilter.ts';
import { getScore, listScores, saveScores } from '../match/score-store.ts';
import { renderStars } from '../match/stars.ts';
import { formatWhy, top, topResolve, topWhy } from '../match/top.ts';
import { SljError } from '../errors.ts';

const Ref = z.string().trim().min(1).max(40);
const Num = z.union([z.string().trim().min(1).max(10), z.number().int().min(1)]);

export const matchPrefilter = defineCommand({
  name: 'match.prefilter',
  summary:
    'Rank open jobs for the CV (title, skills, location, recency; no LLM) and return the window offset..offset+limit minus jobs already ' +
    'scored for this CV, job text and rubric, each with a requirements excerpt to score. Returns the next score_batch (10) of them per call: ' +
    'score and save those, then run the same command again until candidates is empty. Widening options: --titles adjacent|any, ' +
    '--since 30d, --district nearby|any. Variants: --district <name>, --remote, --like <job id or #n>.',
  sideEffect: 'Records widening steps in today\'s report',
  input: z.object({
    limit: z.number().int().min(1).max(500).optional().describe('Window size (default prefilter_n, 60).'),
    offset: z.number().int().min(0).default(0).describe('Start of the window in the ranked pool (scored jobs count too).'),
    titles: z.array(z.string().trim().min(1).max(200)).max(20).optional().describe('target (default), adjacent, any, or your own list of titles.'),
    district: z.string().trim().min(1).max(60).optional().describe('home (default), nearby, any, or one district such as Kandy.'),
    remote: z.boolean().optional().describe('Only remote jobs.'),
    like: Ref.optional().describe('Rank by likeness to this job: a job id or #n from today\'s report.'),
    since: z.string().trim().min(1).max(20).optional().describe('14d, 30d, 60d, all, or YYYY-MM-DD. Default settings.scan.since_days.'),
    include_scored: z.boolean().default(false).describe('Also return jobs that already have a score.'),
    batch: z.number().int().min(0).max(500).optional().describe('Candidates per call (default score_batch, 10). 0 = the whole window at once.'),
    explain: z.boolean().default(false).describe('Add rank, district, posted_at, platform and the prefilter sub-scores to each candidate (debugging the order).'),
    widened: z.array(z.enum(['slow_sources'])).max(5).optional().describe('Record a widening done outside prefilter (after `jobs scan --slow`).'),
  }),
  run(input, ctx) {
    const settings = ctx.config().settings;
    return prefilter(ctx, { ...input, limit: input.limit ?? settings.prefilter_n, batch: input.batch ?? settings.score_batch });
  },
  format: (d) =>
    [
      `Pool: ${d.pool.open} open, ${d.pool.eligible} eligible, ${d.pool.already_scored} scored, ${d.pool.remaining} to score` +
        ` (titles ${d.applied.titles}, since ${d.applied.since}, district ${d.applied.district_name ?? d.applied.district}${d.applied.remote_only ? ', remote only' : ''})`,
      `${d.candidates.length} candidate(s) to score in ranks ${d.window.offset + 1}–${d.window.offset + d.window.size}` +
        (d.left_in_window ? `, ${d.left_in_window} more in this window` : '') +
        (d.next_offset != null ? `; next window --offset ${d.next_offset}` : ''),
      ...d.candidates.map((c: any) => `  ${c.id}  ${c.prefilter ? `${c.prefilter.total.toFixed(3)}  ` : ''}${c.title}${c.company ? ` · ${c.company}` : ''}`),
    ].join('\n'),
});

export const scoreSave = defineCommand({
  name: 'score.save',
  summary:
    'Save a batch of rubric scores (modes/score.md). slj adds up the points, derives the stars and applies the caps (missing mandatory → ' +
    'at most 2 stars; scam → 1 star ⚠️). Bad items are rejected one by one with reasons; the rest are saved.',
  sideEffect: 'Writes scores',
  input: z.object({
    scores: z.array(z.unknown()).min(1).max(50).describe('Items: { job_id, dimensions, requirements[], gaps[], why } plus, only when not empty, scam_signals[], missing_mandatory[], matched[].'),
    model: z.string().trim().min(1).max(100).optional().describe('Your model name, once for the whole batch.'),
  }),
  run(input, ctx) {
    return saveScores(ctx, input.scores, input.model);
  },
  isFailure: (d) => d.failed > 0,
  format: (d) =>
    [
      `Saved ${d.saved}, rejected ${d.failed} (rubric ${d.rubric_version}).`,
      ...d.results.map((r: any) => `  ${r.job_id}  ${renderStars(r.stars)}  ${r.points}/100${r.capped_by ? `  capped: ${r.capped_by}` : ''}`),
      ...d.errors.map((e: any) => `  ! item ${e.index} (${e.job_id ?? '?'}): ${e.problems.join('; ')}`),
    ].join('\n'),
});

export const scoreList = defineCommand({
  name: 'score.list',
  summary: 'List saved scores for the current CV and rubric.',
  sideEffect: null,
  input: z.object({ limit: z.number().int().min(1).max(1000).default(100), offset: z.number().int().min(0).default(0) }),
  run(input, ctx) {
    const key = matchKey(ctx);
    const all = listScores(ctx.db(), key.resume_hash, key.rubric_version).sort((a, b) => b.points - a.points || a.job_id.localeCompare(b.job_id));
    return {
      resume_hash: key.resume_hash,
      rubric_version: key.rubric_version,
      total: all.length,
      scores: all.slice(input.offset, input.offset + input.limit).map((s) => ({
        job_id: s.job_id, points: s.points, stars: s.stars, capped_by: s.capped_by, why: s.why, model: s.model, created_at: s.created_at,
      })),
    };
  },
  format: (d) => [`${d.total} score(s)`, ...d.scores.map((s: any) => `${s.job_id}  ${renderStars(s.stars)}  ${s.points}  ${s.why ?? ''}`)].join('\n'),
});

export const scoreGet = defineCommand({
  name: 'score.get',
  summary: 'One saved score in full (dimensions, requirements with quoted JD phrases, caps) for the current CV and rubric.',
  sideEffect: null,
  positional: 'job_id',
  input: z.object({ job_id: Ref }),
  run(input, ctx) {
    const key = matchKey(ctx);
    const s = getScore(ctx.db(), input.job_id, key.resume_hash, key.rubric_version);
    if (!s) throw new SljError('NOT_FOUND', `No score for ${input.job_id} with this CV and rubric ${key.rubric_version}.`);
    return s;
  },
});

export const topCmd = defineCommand({
  name: 'top',
  summary:
    'The ranked report of scored open jobs, numbered #1… for the day (numbers never change; later pages extend them). Writes ' +
    'user/reports/<date>-top20.md. Returns rows, pool sizes, short_by, recurring gaps for the "How your CV reads" paragraph, and next_step ' +
    'for "more jobs". Variants re-rank the remaining pool: --district Kandy|nearby, --remote, --like #3 (offset is ignored for variants).',
  sideEffect: 'Writes the day\'s report and numbering',
  input: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('Rows (default top_n, 20).'),
    offset: z.number().int().min(0).default(0).describe('0 for the first page, 20 for "more jobs", 40, ...'),
    district: z.string().trim().min(1).max(60).optional().describe('Variant: only this district, or nearby.'),
    remote: z.boolean().optional().describe('Variant: only remote jobs.'),
    like: Ref.optional().describe('Variant: jobs like this one (job id or #n).'),
    summary: z.string().trim().max(1500).optional().describe('Your "How your CV reads to this market" paragraph for the report.'),
    brief: z.boolean().default(false).describe('Leave out rows and return page_markdown instead: this page exactly as it should be shown to the person.'),
  }),
  run(input, ctx) {
    return top(ctx, { ...input, limit: input.limit ?? ctx.config().settings.top_n });
  },
  format: (d) =>
    [
      `Top for ${d.today}${d.variant ? ` (${d.variant})` : ''}: showing ${d.shown}; ${d.pool.numbered_today} numbered of ${d.pool.scored} scored, ${d.pool.open} open.`,
      ...(d.rows ?? []).map((r: any) => `#${String(r.n).padEnd(3)} ${r.fit}  ${r.title}${r.company ? ` · ${r.company}` : ''}  — ${r.why ?? ''}`),
      d.short_by ? `Short by ${d.short_by}.` : '',
      `Next: ${d.next_step.message}${d.next_step.command ? ` (${d.next_step.command})` : ''}`,
      d.report_file ? `Report: ${d.report_file}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
});

export const topWhyCmd = defineCommand({
  name: 'top.why',
  summary: 'The full rubric breakdown for #n in today\'s report: points per dimension, each requirement with the quoted JD phrase and met/partial/missing, caps.',
  sideEffect: null,
  positional: 'n',
  input: z.object({ n: Num }),
  run: (input, ctx) => topWhy(ctx, input.n),
  format: (d) => formatWhy(d),
});

export const topResolveCmd = defineCommand({
  name: 'top.resolve',
  summary: 'The job id behind #n in today\'s report (cv commands take a job id).',
  sideEffect: null,
  positional: 'n',
  input: z.object({ n: Num }),
  run: (input, ctx) => topResolve(ctx, input.n),
  format: (d) => `#${d.n} = ${d.job_id}${d.title ? ` (${d.title})` : ''}`,
});

export const matchEval = defineCommand({
  name: 'match.eval',
  summary: 'M2 gate: compare saved stars with a human-labelled file (CSV job_id,human_stars or JSON). Reports the share within ±1 star and the misses.',
  sideEffect: null,
  input: z.object({
    labels: z.string().trim().min(1).max(1000).describe('Path to the labels file.'),
    resume_hash: z.string().regex(/^[0-9a-f]{16}$/).optional().describe('Scores for this CV instead of the current user/resume.md.'),
  }),
  run: (input, ctx) => evaluate(ctx, input),
  isFailure: (d) => !d.pass,
  format: (d) =>
    [
      `${d.within_1}/${d.compared} within ±1 star (${Math.round(d.within_1_share * 100)}%), ${d.unscored.length} unscored. ${d.pass ? 'PASS' : 'FAIL'} (${d.pass_rule}).`,
      ...d.misses.map((m: any) => `  ${m.job_id}  human ${m.human} vs agent ${m.agent}  ${m.title ?? ''}`),
    ].join('\n'),
});

/** Stream S8: match prefilter, score save/list/get, top, top why, top resolve, match eval. */
export const jobsTranscribe = defineCommand({
  name: 'jobs.transcribe',
  summary:
    'Save what an image ad says, read from its image(s) with your own vision (modes/score.md). Only for image ads (is_image_ad in ' +
    'match prefilter). Write down only what the image shows, word for word where you can; never add or guess. score save then checks ' +
    'jd_quote phrases against this text. Changing it makes the job\'s earlier score stale (it is re-scored).',
  sideEffect: 'Writes the transcribed ad text to the job',
  positional: 'id',
  input: z.object({
    id: z.string().trim().min(1).max(40).describe('The job id.'),
    text: z.string().trim().min(20).max(20_000).describe('The ad\'s text as the image shows it (any language; keep the original wording).'),
  }),
  run(input, ctx) {
    const db = ctx.db();
    const row = db.prepare('SELECT id, title, is_image_ad, ad_text FROM jobs WHERE id = ?').get(input.id) as
      | { id: string; title: string; is_image_ad: number; ad_text: string | null }
      | undefined;
    if (!row) throw new SljError('NOT_FOUND', `No job with id ${input.id}.`);
    if (!row.is_image_ad) {
      throw new SljError('INVALID_INPUT', `Job ${input.id} is not an image ad: its text is already in the description. Score it from that.`);
    }
    // Only plain text is kept: no markup, no control characters (it is data shown to the scorer, never instructions).
    const text = input.text.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim();
    const at = ctx.now().toISOString();
    db.prepare('UPDATE jobs SET ad_text = ?, ad_text_at = ? WHERE id = ?').run(text, at, input.id);
    return { id: input.id, title: row.title, chars: text.length, replaced: row.ad_text != null, at };
  },
  format: (d) => `Saved ${d.chars} characters of ad text for ${d.id} (${d.title})${d.replaced ? ', replacing the earlier transcription' : ''}.`,
});

export const matchCommands: Command[] = [jobsTranscribe, matchPrefilter, scoreSave, scoreList, scoreGet, topCmd, topWhyCmd, topResolveCmd, matchEval] as Command[];
