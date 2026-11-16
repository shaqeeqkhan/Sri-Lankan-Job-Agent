import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createContext, type Context } from '../src/context.ts';
import { execute, type Command } from '../src/registry.ts';
import { makeCtx, ROOT, seedJobs, tempDir, type SeedJob } from './helpers.ts';

export const NOW = new Date('2026-11-15T04:00:00Z');

export const PROFILE = {
  name: { value: 'Nimali Perera', inferred: true },
  target_titles: { value: ['Data Analyst', 'BI Analyst'], inferred: true },
  adjacent_titles: { value: ['Reporting Analyst', 'Business Analyst'], inferred: true },
  seniority: { value: 'junior', inferred: true },
  years_experience: { value: 2, inferred: true },
  skills: { value: ['SQL', 'Power BI', 'Excel', 'Python'], inferred: true },
  location: { value: 'Colombo', inferred: true },
  districts_ok: { value: ['Colombo'], inferred: true },
  work_mode: { value: 'hybrid', inferred: false },
  cv_style: { value: 'modern', inferred: true },
};

export const RESUME = `# Nimali Perera
Junior data analyst. SQL, Power BI dashboards, Excel models, some Python for data cleaning.
## Experience
Data Analyst, Lanka Retail (Pvt) Ltd, 2024–2026. Built Power BI sales dashboards; wrote SQL reports.
`;

export const DESC = (extra = '') =>
  `We are a fast-growing company in Colombo.\n\n**Requirements**\n- Degree in Statistics, IT or a related field\n- 2+ years of SQL\n- Experience with Power BI dashboards\n- Advanced Excel\n${extra}`;

export function matchCtx(opts: { configDir?: string; home?: string; now?: Date; profile?: object } = {}): Context {
  const ctx = opts.home
    ? createContext({
        env: { PATH: process.env.PATH ?? '', SLJ_HOME: opts.home, SLJ_CONFIG_DIR: opts.configDir ?? path.join(ROOT, 'config') },
        driver: 'test',
        now: () => opts.now ?? NOW,
      })
    : makeCtx({ now: opts.now ?? NOW, configDir: opts.configDir });
  if (!fs.existsSync(ctx.paths.resumeFile)) fs.writeFileSync(ctx.paths.resumeFile, RESUME);
  if (opts.profile || !fs.existsSync(ctx.paths.profileFile)) fs.writeFileSync(ctx.paths.profileFile, YAML.stringify(opts.profile ?? PROFILE));
  return ctx;
}

/** A config dir copy with settings overrides (e.g. a new rubric_version). */
export function configWith(over: Record<string, unknown>): string {
  const dir = tempDir('slj-config-');
  for (const f of fs.readdirSync(path.join(ROOT, 'config'))) fs.copyFileSync(path.join(ROOT, 'config', f), path.join(dir, f));
  const settings = YAML.parse(fs.readFileSync(path.join(dir, 'settings.yml'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'settings.yml'), YAML.stringify({ ...settings, ...over }));
  return dir;
}

/** seedJobs with a distinct external id and apply address per ref, so the store never merges them. */
export function seed(ctx: Context, jobs: SeedJob[]): string[] {
  return seedJobs(ctx, jobs.map((j) => ({ external_id: j.ref, apply_email: `${j.ref}@jobs.example.lk`, ...j })));
}

let seq = 0;
/** n open data-analyst-ish jobs with distinct companies, closing in the future. */
export function seedMany(ctx: Context, n: number, over: (i: number) => SeedJob = () => ({})): string[] {
  const jobs: SeedJob[] = [];
  for (let i = 0; i < n; i++) {
    const k = ++seq;
    jobs.push({
      ref: `m-${k}`,
      source_url: `https://xpress.jobs/jobs/${k}`,
      external_id: String(k),
      title: 'Data Analyst',
      company: `Company ${k}`,
      location: 'Colombo 03',
      closing_date: '2026-12-01',
      apply_email: `jobs${k}@example.lk`,
      description: DESC(`- Item ${k}`),
      ...over(i),
    });
  }
  return seedJobs(ctx, jobs);
}

/** A valid score item: `points` spread across the dimensions (≤ each weight). */
export function item(jobId: string, points: number, extra: Record<string, unknown> = {}) {
  const weights: [string, number][] = [['must_haves', 30], ['role_fit', 25], ['seniority', 15], ['education', 10], ['location', 10], ['domain', 10]];
  const dims: Record<string, number> = {};
  let left = points;
  for (const [k, w] of weights) {
    dims[k] = Math.min(w, left);
    left -= dims[k];
  }
  return {
    job_id: jobId,
    dimensions: dims,
    requirements: [
      { text: 'SQL', jd_quote: '2+ years of SQL', status: 'met' },
      { text: 'Power BI', jd_quote: 'experience with  power bi dashboards', status: 'partial' },
    ],
    matched: ['SQL'],
    gaps: ['No cloud (AWS/Azure)'],
    why: 'SQL and Power BI named; cloud missing',
    scam_signals: [],
    missing_mandatory: [],
    model: 'test-model',
    ...extra,
  };
}

export async function run(cmd: Command, input: object, ctx: Context): Promise<any> {
  const res = (await execute(cmd, input, ctx)) as any;
  if (!res.ok) throw new Error(`${cmd.name} failed: ${res.error.code} ${res.error.message}`);
  return res.data;
}
