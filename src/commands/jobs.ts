import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { allPlatforms, platformForHost, type Config } from '../config.ts';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { defineCommand } from '../registry.ts';
import { extract, type Extraction } from '../jobs/extract.ts';
import { fetchPage } from '../jobs/http.ts';
import { canonicalUrl, inferApplyMethod } from '../jobs/normalize.ts';
import { ApplyMethod, JobFields, NON_ADAPTER_PLATFORMS } from '../jobs/schema.ts';
import { cleanDescription } from '../jobs/clean.ts';
import { colomboToday, getJob, listJobs, upsertJob } from '../jobs/store.ts';
import { sourceConfigs } from '../sources/load.ts';
import type { HttpClient } from '../sources/types.ts';

export { colomboToday };
/** `jobs scan` / `jobs recheck` are registered through sourcesCommands (index.ts is frozen); re-exported here. */
export { jobsRecheck, jobsScan } from './sources.ts';

const MAX_PAGE_BYTES = 3 * 1024 * 1024;

/**
 * Loads a pasted link through the one HTTP door (`src/sources/http.ts`) when it exists, else the
 * Phase 0 `fetchPage`. Same result shape and the same FETCH_FAILED errors either way.
 */
async function loadPage(ctx: Context, url: URL): Promise<{ html: string; finalUrl: string; contentType: string }> {
  let client: (HttpClient & { close?(): Promise<void> }) | undefined;
  try {
    const mod = (await import('../sources/http.ts')) as { createHttpClient?: (o: { fetch?: typeof fetch }) => HttpClient & { close?(): Promise<void> } };
    client = mod.createHttpClient?.({ fetch: ctx.fetch });
  } catch {
    client = undefined;
  }
  if (!client) return fetchPage(ctx.fetch, url);
  try {
    const res = await client.get(url.toString(), { timeoutMs: 20_000 });
    if (res.status < 200 || res.status >= 300) throw new SljError('FETCH_FAILED', `${url.host} returned HTTP ${res.status}.`);
    const contentType = res.headers['content-type'] ?? '';
    if (contentType && !/text\/|xhtml|xml/.test(contentType)) {
      throw new SljError('FETCH_FAILED', `The link is a ${contentType} file. Download it and use --file instead.`);
    }
    if (Buffer.byteLength(res.text) > MAX_PAGE_BYTES) throw new SljError('FETCH_FAILED', 'The page is larger than 3 MB.');
    return { html: res.text, finalUrl: res.url || url.toString(), contentType: contentType || 'text/html' };
  } finally {
    await client.close?.().catch(() => {});
  }
}

function knownPlatforms(config: Config): string[] {
  return [...allPlatforms(config.sources).map((p) => p.id), ...NON_ADAPTER_PLATFORMS];
}

/** Platform for a URL: the source or platform id, or "social" for Facebook/WhatsApp-type hosts. */
function platformForUrl(config: Config, raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const p = platformForHost(config.sources, new URL(raw).hostname);
    if (!p) return undefined;
    return p.kind === 'social' ? 'social' : p.id;
  } catch {
    return undefined;
  }
}

function isPortal(config: Config, platform: string): boolean {
  const p = allPlatforms(config.sources).find((x) => x.id === platform);
  return !!p && ['board', 'ats', 'government', 'company'].includes(p.kind);
}

// ---------------------------------------------------------------- jobs add

const TEXT_EXT = new Set(['.txt', '.md', '.html', '.htm']);
const DOC_EXT = new Set(['.pdf', '.docx', '.doc']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function resolveUserFile(raw: string, allowed: Set<string>, what: string): { abs: string; ext: string; bytes: Buffer } {
  const abs = path.resolve(raw.replace(/^~(?=$|[/\\])/, os.homedir()));
  const ext = path.extname(abs).toLowerCase();
  if (!allowed.has(ext)) {
    throw new SljError('FILE_REJECTED', `${what} must be one of: ${[...allowed].join(', ')}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new SljError('NOT_FOUND', `No file at ${abs}`);
  }
  if (!stat.isFile()) throw new SljError('FILE_REJECTED', `${abs} is not a file.`);
  if (stat.size > MAX_FILE_BYTES) throw new SljError('FILE_REJECTED', 'Files must be 20 MB or smaller.');
  return { abs, ext, bytes: fs.readFileSync(abs) };
}

/** Keep a copy of the ad in user/inbox/, named by content so re-adding is idempotent. */
function saveToInbox(ctx: Context, bytes: Buffer, ext: string): { rel: string; digest: string } {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(ctx.paths.inboxDir, { recursive: true });
  const name = `${digest.slice(0, 16)}${ext}`;
  const dest = path.join(ctx.paths.inboxDir, name);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, bytes);
  return { rel: path.relative(ctx.paths.userDir, dest), digest };
}

const FIELD_NAMES = Object.keys(JobFields.shape) as (keyof JobFields)[];

/** Drop extracted values that would not validate; the agent can supply them instead. */
function validExtracted(fields: Partial<JobFields>): Partial<JobFields> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const shape = JobFields.shape[k as keyof JobFields];
    if (shape && shape.safeParse(v).success) out[k] = v;
  }
  return out as Partial<JobFields>;
}

const REVIEWED_FIELDS = ['apply_email', 'closing_date', 'apply_phone'] as const;

export const jobsAdd = defineCommand({
  name: 'jobs.add',
  summary:
    'Add a job from a pasted link, a file (PDF, Word, text, HTML), a photo or screenshot of an ad, or pasted text. ' +
    'Fields you pass override what slj reads from the ad. If the title cannot be read, it fails with NEEDS_FIELDS and a draft to complete.',
  sideEffect: 'Writes jobs',
  input: JobFields.partial().extend({
    url: z.string().max(2000).optional().describe('Link to the job ad.'),
    file: z.string().max(1000).optional().describe('Path to a PDF, Word, text or HTML file of the ad.'),
    image: z.string().max(1000).optional().describe('Path to a photo of a newspaper ad or a screenshot of a social post.'),
    text: z.string().max(100_000).optional().describe('The ad text, pasted.'),
    html: z
      .string()
      .max(3_000_000)
      .optional()
      .describe('The page HTML, when you loaded the page with your own web tools (fallback tier T4). Pass --url too so the source link is kept; it is not fetched again.'),
    platform: z.string().max(50).optional().describe('Adapter id from config/sources.yml, or email, social, newspaper, other.'),
    apply_method: ApplyMethod.optional(),
    confirmed: z
      .boolean()
      .default(false)
      .describe('The person has checked the apply email, phone and closing date you pass. Skips the review flag.'),
  }),
  async run(input, ctx) {
    const config = ctx.config();
    const { url, file, image, text, html, platform: platformIn, confirmed, ...rest } = input;
    const given: Partial<JobFields> = Object.fromEntries(
      FIELD_NAMES.filter((k) => rest[k] != null).map((k) => [k, rest[k]]),
    );
    if (!url && !file && !image && !text && !html && !given.title) {
      throw new SljError('INVALID_INPUT', 'Give a url, html, file, image or text, or at least a title.');
    }
    if (platformIn && !knownPlatforms(config).includes(platformIn)) {
      throw new SljError('INVALID_INPUT', `Unknown platform "${platformIn}". Use one of: ${knownPlatforms(config).join(', ')}`);
    }

    const notes: string[] = [];
    let extraction: Extraction | undefined;
    let sourceUrl: string | null = null;
    let sourceRef: string | undefined;
    let imagePath: string | null = null;
    let fromImage = false;

    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new SljError('INVALID_INPUT', `Not a valid link: ${url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new SljError('INVALID_INPUT', 'Only http and https links.');
      sourceUrl = canonicalUrl(url);
      sourceRef = sourceUrl ?? url;
      const site = platformForHost(config.sources, parsed.hostname);
      if (site?.fetch_policy === 'no_automated_fetch') {
        // Not by slj, and not by the agent's own web tools either (--html is ignored here).
        notes.push(`${site.name} is never fetched automatically. Open the link, then pass the ad's text with --text or a screenshot with --image.`);
      } else if (html) {
        // T4: the agent already loaded the page itself. Never fetched again.
        extraction = extract({ html });
      } else {
        const page = await loadPage(ctx, parsed);
        extraction = extract(/html/.test(page.contentType) ? { html: page.html } : { text: page.html });
      }
    }

    if (file) {
      const f = resolveUserFile(file, new Set([...TEXT_EXT, ...DOC_EXT, ...IMAGE_EXT]), '--file');
      const saved = saveToInbox(ctx, f.bytes, f.ext);
      sourceRef ??= `sha256:${saved.digest}`;
      if (IMAGE_EXT.has(f.ext)) {
        imagePath = saved.rel;
        fromImage = true;
      } else if (TEXT_EXT.has(f.ext)) {
        const body = f.bytes.toString('utf8');
        extraction ??= extract(f.ext.startsWith('.htm') ? { html: body } : { text: body });
      } else {
        notes.push(`Saved ${saved.rel}. slj does not read ${f.ext} files itself: read it and pass the fields.`);
      }
    }

    if (image) {
      const f = resolveUserFile(image, IMAGE_EXT, '--image');
      const saved = saveToInbox(ctx, f.bytes, f.ext);
      sourceRef ??= `sha256:${saved.digest}`;
      imagePath = saved.rel;
      fromImage = true;
    }

    if (html && !url) {
      extraction ??= extract({ html });
      sourceRef ??= `sha256:${crypto.createHash('sha256').update(html).digest('hex')}`;
    }

    if (text) {
      extraction ??= extract({ text });
      sourceRef ??= `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
    }

    const extracted = validExtracted(extraction?.fields ?? {});
    const fields: Partial<JobFields> = { ...extracted, ...given };
    if (fromImage) fields.is_image_ad = true;

    const reviewReasons: string[] = [];
    if (!confirmed) {
      for (const f of REVIEWED_FIELDS) {
        if (!fields[f]) continue;
        if (given[f] && fromImage) reviewReasons.push(`${f} was read from an image; check it against the ad.`);
        else if (!given[f] && extraction?.uncertain.includes(f)) reviewReasons.push(`${f} was read automatically from the ad text; check it.`);
      }
      if (!fields.apply_email && (extraction?.candidates.emails.length ?? 0) > 1) {
        reviewReasons.push('The ad lists several email addresses; choose the one to apply to.');
      }
    }
    notes.push(...(extraction?.warnings ?? []));

    const platform =
      platformIn ?? platformForUrl(config, url) ?? platformForUrl(config, fields.apply_url) ?? (fields.apply_email ? 'email' : 'other');

    const missing = ['title'].filter((k) => !fields[k as keyof JobFields]);
    if (missing.length) {
      throw new SljError('NEEDS_FIELDS', `Could not read the ${missing.join(', ')} from the ad. Read it yourself and call jobs add again with the same source plus the fields.`, {
        missing,
        draft: { ...fields, description: fields.description?.slice(0, 2000), platform },
        saved_image: imagePath,
        notes,
      });
    }

    if (fields.description) fields.description = cleanDescription(fields.description) || undefined;
    const final = JobFields.safeParse(fields);
    if (!final.success) throw new SljError('INVALID_INPUT', z.prettifyError(final.error), z.flattenError(final.error));

    sourceRef ??= `fields:${crypto.createHash('sha256').update(`${final.data.title}|${final.data.company ?? ''}`).digest('hex')}`;
    const { id, outcome } = upsertJob(
      ctx.db(),
      {
        ...final.data,
        platform,
        apply_method: inferApplyMethod(final.data, isPortal(config, platform)),
        image_path: imagePath,
        review_reasons: reviewReasons,
      },
      { source: 'manual', source_ref: sourceRef, source_url: sourceUrl },
      ctx.now(),
      { precedence: sourceConfigs(config).map((s) => s.id) },
    );
    const { description: _d, ...job } = getJob(ctx.db(), id)!;
    return { id, outcome, needs_review: job.needs_review, review_reasons: job.review_reasons, notes, job };
  },
  format: (d) =>
    [
      `${d.outcome === 'inserted' ? 'Added' : d.outcome === 'merged' ? 'Merged into' : 'Already have'} ${d.id}: ${d.job.title}${d.job.company ? ` at ${d.job.company}` : ''}`,
      `  apply by ${d.job.apply_method}${d.job.apply_email ? ` to ${d.job.apply_email}` : ''}${d.job.closing_date ? `, closes ${d.job.closing_date}` : ''}`,
      ...d.review_reasons.map((r: string) => `  ! ${r}`),
      ...d.notes.map((n: string) => `  · ${n}`),
    ].join('\n'),
});

// ---------------------------------------------------------------- jobs list / get

export const jobsList = defineCommand({
  name: 'jobs.list',
  summary: 'List jobs with filters. Closed jobs (closing date passed, or found closed by a recheck) are hidden unless include_closed is set.',
  sideEffect: null,
  input: z.object({
    q: z.string().max(200).optional().describe('Text to find in the title, company or description.'),
    platform: z.string().max(50).optional(),
    apply_method: ApplyMethod.optional(),
    location: z.string().max(100).optional(),
    district: z.string().max(40).optional().describe('Sri Lankan district, e.g. Colombo, Kandy, Nuwara Eliya.'),
    category: z.string().max(100).optional(),
    source: z.string().max(100).optional(),
    since: z.string().max(40).optional().describe('Only jobs fetched at or after this ISO time.'),
    include_closed: z.boolean().default(false),
    closing_within_days: z.number().int().min(0).max(365).optional(),
    needs_review: z.boolean().optional(),
    min_stars: z.number().int().min(1).max(5).optional(),
    sort: z.enum(['closing', 'newest', 'score']).default('closing'),
    limit: z.number().int().min(1).max(500).default(50),
    offset: z.number().int().min(0).default(0),
  }),
  run(input, ctx) {
    const today = colomboToday(ctx.now());
    return { today, ...listJobs(ctx.db(), input, today) };
  },
  format: (d) =>
    [
      `${d.total} job(s)${d.total > d.jobs.length ? `, showing ${d.jobs.length}` : ''}`,
      ...d.jobs.map(
        (j: any) =>
          `${j.id}  ${(j.closing_date ?? '—').padEnd(10)}  ${j.apply_method.padEnd(7)} ${j.stars != null ? `[${'★'.repeat(j.stars)}] ` : ''}${j.title}${j.company ? ` · ${j.company}` : ''}${j.needs_review ? '  (check)' : ''}`,
      ),
    ].join('\n'),
});

export const jobsGet = defineCommand({
  name: 'jobs.get',
  summary: 'Get one job in full: description, apply details, every source it was seen in, and its latest score.',
  sideEffect: null,
  positional: 'id',
  input: z.object({ id: z.string().min(1).max(40) }),
  run(input, ctx) {
    const job = getJob(ctx.db(), input.id);
    if (!job) throw new SljError('NOT_FOUND', `No job with id ${input.id}. Use \`slj jobs list\` to see ids.`);
    return job;
  },
});
