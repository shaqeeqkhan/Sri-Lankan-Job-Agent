import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { getJob } from '../jobs/store.ts';

/**
 * user/output/<job-id>/cv.md is the one source for a tailored CV. The format is documented in
 * modes/tailor.md: an optional YAML front matter block, then Markdown.
 *
 *   ---
 *   name: Nimal Perera
 *   email: nimal.perera@example.com
 *   phone: +94 77 123 4567
 *   location: Colombo
 *   links: [linkedin.com/in/nimalperera]
 *   role: Junior Data Analyst        # used for the file name only; never printed
 *   style: modern                    # modern | traditional (cv render --style overrides)
 *   ---
 */
export const FrontMatterSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(60).optional(),
    location: z.string().trim().max(120).optional(),
    links: z.array(z.string().trim().min(1).max(300)).max(6).optional(),
    role: z.string().trim().max(120).optional(),
    style: z.enum(['modern', 'traditional']).optional(),
  })
  .strict();
export type FrontMatter = z.infer<typeof FrontMatterSchema>;

export interface CvDoc {
  raw: string;
  front: FrontMatter;
  /** Markdown after the front matter. */
  body: string;
  /** 1-based line number in the file where `body` starts. */
  bodyStartLine: number;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseCvMd(raw: string): CvDoc {
  const m = FRONT.exec(raw);
  if (!m) return { raw, front: {}, body: raw, bodyStartLine: 1 };
  let data: unknown;
  try {
    data = YAML.parse(m[1]) ?? {};
  } catch (err) {
    throw new SljError('INVALID_INPUT', `cv.md front matter is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = FrontMatterSchema.safeParse(data);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(front matter)'}: ${i.message}`);
    throw new SljError('INVALID_INPUT', `cv.md front matter is invalid: ${problems.join('; ')}`, { problems });
  }
  const bodyStartLine = m[0].split('\n').length - (m[0].endsWith('\n') ? 0 : 1);
  return { raw, front: parsed.data, body: raw.slice(m[0].length), bodyStartLine };
}

export function sha16(text: string | Buffer): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

/** The job's output folder. The id is checked first so it can never point outside user/output/. */
export function jobDir(ctx: Pick<Context, 'paths'>, jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new SljError('INVALID_INPUT', `"${jobId}" is not a job id.`);
  return path.join(ctx.paths.outputDir, jobId);
}

export function requireJob(ctx: Context, jobId: string) {
  jobDir(ctx, jobId);
  const job = getJob(ctx.db(), jobId);
  if (!job) throw new SljError('NOT_FOUND', `No job with id ${jobId}. Use \`slj top resolve <n>\` to turn #N into a job id.`);
  return job;
}

export function cvMdPath(ctx: Pick<Context, 'paths'>, jobId: string): string {
  return path.join(jobDir(ctx, jobId), 'cv.md');
}

export function readCvMd(ctx: Pick<Context, 'paths'>, jobId: string): { file: string; text: string; doc: CvDoc } {
  const file = cvMdPath(ctx, jobId);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new SljError('NOT_FOUND', `There is no cv.md for this job yet. Write it to ${file} (modes/tailor.md).`, { path: file });
  }
  return { file, text, doc: parseCvMd(text) };
}

/** First "# Name" heading in the body, if the front matter gives no name. */
export function cvName(doc: CvDoc): string | null {
  if (doc.front.name) return doc.front.name;
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(doc.body);
  return h1 ? h1[1].replace(/[*_`]/g, '').trim() : null;
}

function ascii(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function part(s: string): string {
  return ascii(s).replace(/[^A-Za-z0-9]+/g, '');
}

/**
 * `Firstname_Lastname_Role.pdf` (PRD §8.2). Initials ("K. A.") are skipped when choosing the first name,
 * so "K. A. Nimal Perera" gives Nimal_Perera. Role words are joined with `_`; brackets are dropped.
 */
export function cvFileBase(name: string | null, role: string | null): string {
  const words = (name ?? '').split(/\s+/).map(part).filter(Boolean);
  const nonInitial = words.filter((w) => w.length > 1);
  const pick = nonInitial.length ? nonInitial : words;
  const first = pick[0] ?? 'CV';
  const last = pick.length > 1 ? pick[pick.length - 1] : '';
  const roleWords = ascii(role ?? '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6);
  const base = [first, last, ...roleWords].filter(Boolean).join('_');
  return base.slice(0, 80).replace(/_+$/, '') || 'CV';
}
