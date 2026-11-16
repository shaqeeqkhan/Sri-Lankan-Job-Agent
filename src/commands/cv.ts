import { z } from 'zod';
import { defineCommand, type Command } from '../registry.ts';
import { loadFacts } from '../user/profile.ts';
import { runAtsCheck, type AtsReport } from '../cv/ats-check.ts';
import { runFactcheck, type FactcheckReport } from '../cv/factcheck.ts';
import { addFact } from '../cv/facts.ts';
import { renderCv, type RenderResult } from '../cv/render.ts';

const JobId = z.string().trim().min(1).max(80).describe('Job id (from `slj top resolve <n>` or `slj jobs list`).');

export const factcheck = defineCommand({
  name: 'factcheck',
  summary:
    'Check user/output/<job>/cv.md against user/resume.md and user/facts.yml. Fails on any employer, title, date, number, ' +
    'qualification or tool that is in neither (the job ad does not count). `cv render` refuses until this passes.',
  sideEffect: 'Records the result',
  input: z.object({ job: JobId }),
  run: (input, ctx) => runFactcheck(ctx, input.job),
  isFailure: (d: FactcheckReport) => !d.passed,
  format: (d: FactcheckReport) => {
    if (d.passed) return `Factcheck passed: ${d.claims_checked} claims checked in ${d.cv_md}, all supported.`;
    const lines = [`Factcheck FAILED: ${d.unsupported.length} unsupported claim(s) of ${d.claims_checked} checked. Fix cv.md and run it again.`];
    for (const u of d.unsupported) {
      lines.push(`  line ${u.line}  [${u.kind}] "${u.claim}" - ${u.reason}`);
      if (u.nearest) lines.push(`      nearest: ${u.nearest.source}  ${u.nearest.text}`);
    }
    return lines.join('\n');
  },
});

export const cvRender = defineCommand({
  name: 'cv.render',
  summary:
    'Render user/output/<job>/cv.md to HTML and an A4 PDF named Firstname_Lastname_Role.pdf, with the srilankanjobs.lk footer. ' +
    'Reports the page count; a modern CV over the page limit is tightened, then returned as over_limit for you to cut.',
  sideEffect: 'Writes the CV HTML and PDF',
  input: z.object({
    job: JobId,
    style: z.enum(['modern', 'traditional']).optional().describe('Default: cv.md front matter, then settings, then profile.yml.'),
    page_size: z.enum(['A4', 'Letter']).optional().describe('Default: cv.page_size in settings.yml (A4).'),
  }),
  run: (input, ctx) => renderCv(ctx, input),
  isFailure: (d: RenderResult) => d.status === 'over_limit',
  format: (d: RenderResult) =>
    [
      `${d.status === 'ok' ? 'Rendered' : d.status === 'over_limit' ? 'OVER THE PAGE LIMIT' : 'HTML only (print it by hand)'}: ${d.style} CV`,
      `  html: ${d.html}`,
      d.pdf ? `  pdf:  ${d.pdf}  (${d.pages} page(s)${d.max_pages ? `, limit ${d.max_pages}` : ''})` : null,
      d.tightening.length ? `  tightened: ${d.tightening.join(', ')}` : null,
      `  watermark: ${d.watermark.placement}${d.watermark.size_pt ? ` at ${d.watermark.size_pt} pt` : ''}`,
      d.guidance ? `  ${d.guidance}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
});

export const cvAtsCheck = defineCommand({
  name: 'cv.ats-check',
  summary:
    "Read the rendered PDF's text layer: name, email, phone, the job's keywords that the CV legitimately has, the watermark, " +
    'and no file:// or home-folder path. Keywords come from --keywords, else from the saved score.',
  sideEffect: 'Records the result',
  input: z.object({
    job: JobId,
    keywords: z
      .array(z.string().trim().min(1).max(80))
      .max(60)
      .optional()
      .describe('Must-have terms from the ad, comma separated on the CLI.'),
  }),
  run: (input, ctx) => runAtsCheck(ctx, { job: input.job, keywords: input.keywords }),
  isFailure: (d: AtsReport) => !d.passed,
  format: (d: AtsReport) =>
    [
      `ATS check ${d.passed ? 'passed' : 'FAILED'} (${d.pages} page(s)): ${d.pdf}`,
      ...d.rows.map((r) => `  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.check.padEnd(26)} ${r.expected}  (${r.detail})`),
      d.gaps.length ? `  gaps (in the ad, not in your CV; never add them unless true): ${d.gaps.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
});

export const factsAdd = defineCommand({
  name: 'facts.add',
  summary:
    'Append a fact the person confirmed during a tailoring interview to user/facts.yml (source: interview). ' +
    'Refuses unless --confirmed is passed after the person said the wording is right.',
  sideEffect: 'Writes user/facts.yml',
  input: z.object({
    text: z.string().trim().min(1).max(2000).describe('The fact in the person\'s own words, e.g. "The dashboard was used by 40 branch managers."'),
    kind: z.string().trim().min(1).max(40).describe('metric, tool, scope, education, referee, personal, ...'),
    id: z.string().trim().min(1).max(60).optional(),
    confirmed: z.boolean().default(false).describe('The person confirmed this exact wording.'),
  }),
  run: (input, ctx) => addFact(ctx, input),
  format: (d) => `Saved fact ${d.fact.id} (${d.count} in ${d.path}).`,
});

export const factsList = defineCommand({
  name: 'facts.list',
  summary: 'List the confirmed interview facts in user/facts.yml.',
  sideEffect: null,
  input: z.object({}),
  run: (_input, ctx) => {
    const facts = loadFacts(ctx);
    return { count: facts.length, facts };
  },
  format: (d) => (d.count ? d.facts.map((f: { id: string; kind: string; text: string }) => `${f.id} [${f.kind}] ${f.text}`).join('\n') : 'No facts yet.'),
});

/** Stream S9 (cv render, cv ats-check, factcheck, facts add/list). */
export const cvCommands: Command[] = [factcheck, cvRender, cvAtsCheck, factsAdd, factsList] as Command[];
