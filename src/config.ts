import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { SljError } from './errors.ts';

// ---------------------------------------------------------------- settings.yml

const SettingsSchema = z.object({
  language: z.enum(['en', 'si', 'ta']),
  /** Minimum points (0–100) for each star band. Below `two` is one star. */
  stars: z
    .object({
      five: z.number().int().min(0).max(100),
      four: z.number().int().min(0).max(100),
      three: z.number().int().min(0).max(100),
      two: z.number().int().min(0).max(100),
    })
    .refine((s) => s.five > s.four && s.four > s.three && s.three > s.two, 'star bands must go down: five > four > three > two'),
  top_n: z.number().int().min(1).max(100),
  prefilter_n: z.number().int().min(1).max(500),
  score_batch: z.number().int().min(1).max(50),
  rubric_version: z.string().trim().min(1).max(40),
  scan: z.object({
    since_days: z.number().int().min(1).max(365),
    source_workers: z.number().int().min(1).max(16),
    listing_cache_hours: z.number().min(0).max(168),
    detail_cache_hours: z.number().min(0).max(720),
    html_delay_ms: z.number().int().min(1000).max(60_000),
    api_delay_ms: z.number().int().min(250).max(60_000),
    /** Seconds one source may spend starting detail fetches in a scan; 0 = no limit. */
    source_budget_s: z.number().int().min(0).max(3600).default(150),
  }),
  cv: z.object({
    page_size: z.enum(['A4', 'Letter']),
    style: z.enum(['auto', 'modern', 'traditional']),
    modern_max_pages: z.number().int().min(1).max(4),
    watermark: z.object({
      enabled: z.boolean(),
      size_pt: z.number().min(4).max(6),
      text: z.string().trim().min(1).max(200),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use a #rrggbb colour'),
    }),
  }),
});

// ---------------------------------------------------------------- sources.yml

export const TIERS = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6'] as const;
const Id = z.string().regex(/^[a-z0-9_]+$/, 'ids are lower-case letters, digits and _');

/** One scanned source. Matches `SourceConfig` in src/sources/types.ts plus `priority` and `notes`. */
const SourceEntrySchema = z.object({
  id: Id,
  name: z.string().min(1),
  kind: z.enum(['board', 'ats', 'government']),
  priority: z.enum(['P1', 'P2', 'P3']),
  hosts: z.array(z.string().min(1)).min(1),
  enabled: z.boolean(),
  slow: z.boolean(),
  tiers: z.array(z.enum(TIERS)).min(1),
  max_details: z.number().int().min(0).max(5000),
  delay_ms: z.number().int().min(250).max(60_000),
  options: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().optional(),
});

/** A host that is never scanned, kept so `jobs add` can label a pasted link. */
const PlatformSchema = z.object({
  id: Id,
  name: z.string().min(1),
  kind: z.enum(['board', 'ats', 'government', 'social', 'network', 'company']),
  hosts: z.array(z.string().min(1)).min(1),
  /** no_automated_fetch: `jobs add --url` never requests the page; the person pastes text or a screenshot. */
  fetch_policy: z.enum(['allowed', 'no_automated_fetch']).default('allowed'),
  notes: z.string().optional(),
});

const SourcesSchema = z
  .object({
    /** Order is dedup precedence: the first source to store a job wins. */
    sources: z.array(SourceEntrySchema).min(1),
    platforms: z.array(PlatformSchema).default([]),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const id of [...s.sources.map((x) => x.id), ...s.platforms.map((x) => x.id)]) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `duplicate id "${id}"` });
      seen.add(id);
    }
  });

// ---------------------------------------------------------------- boards.json

const BoardList = z.array(z.union([z.string().min(1), z.record(z.string(), z.unknown())]));
const BoardsSchema = z.object({
  workday: BoardList,
  greenhouse: BoardList,
  lever: BoardList,
  ashby: BoardList,
  smartrecruiters: BoardList,
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Sources = z.infer<typeof SourcesSchema>;
export type SourceEntry = z.infer<typeof SourceEntrySchema>;
export type Platform = z.infer<typeof PlatformSchema>;
export type Boards = z.infer<typeof BoardsSchema>;

export interface Config {
  settings: Settings;
  /** config/sources.yml: `sources` (scanned, in precedence order) and `platforms` (label-only hosts). */
  sources: Sources;
  /** config/boards.json, keyed by ATS family. */
  boards: Boards;
}

function validate<T>(file: string, raw: unknown, schema: z.ZodType<T>): T {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SljError('CONFIG_INVALID', `${path.basename(file)} is empty or not a mapping.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`);
    throw new SljError('CONFIG_INVALID', `${path.basename(file)} is invalid: ${problems.join('; ')}`, { file, problems });
  }
  return parsed.data;
}

function read(file: string, parse: (s: string) => unknown): unknown {
  try {
    return parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SljError('CONFIG_INVALID', `Cannot read ${path.basename(file)}: ${(err as Error).message}`, { file });
  }
}

/** Loads and validates every config file. A missing or bad file throws CONFIG_INVALID; nothing falls back to empty. */
export function loadConfig(configDir: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = (n: string) => path.join(configDir, n);
  const settings = validate(file('settings.yml'), read(file('settings.yml'), YAML.parse), SettingsSchema);
  const sources = validate(file('sources.yml'), read(file('sources.yml'), YAML.parse), SourcesSchema);
  const boards = validate(file('boards.json'), read(file('boards.json'), JSON.parse), BoardsSchema);
  if (env.SLJ_SOURCE_WORKERS != null && env.SLJ_SOURCE_WORKERS !== '') {
    const n = Number(env.SLJ_SOURCE_WORKERS);
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      throw new SljError('CONFIG_INVALID', `SLJ_SOURCE_WORKERS must be a whole number from 1 to 16, not "${env.SLJ_SOURCE_WORKERS}".`);
    }
    settings.scan.source_workers = n;
  }
  return { settings, sources, boards };
}

export interface PlatformInfo {
  id: string;
  name: string;
  kind: Platform['kind'];
  hosts: string[];
  fetch_policy: Platform['fetch_policy'];
}

/** Every labelled host: scanned sources first, then the never-scanned platforms. */
export function allPlatforms(sources: Sources): PlatformInfo[] {
  return [
    ...sources.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, hosts: s.hosts, fetch_policy: 'allowed' as const })),
    ...sources.platforms.map((p) => ({ id: p.id, name: p.name, kind: p.kind, hosts: p.hosts, fetch_policy: p.fetch_policy })),
  ];
}

/**
 * Match a hostname to a configured source or platform. Pass `config.sources` to search both lists,
 * or any array of `{ hosts }`. Host patterns may start with "*.".
 */
export function platformForHost(list: Sources | PlatformInfo[], host: string): PlatformInfo | undefined;
export function platformForHost<T extends { hosts: string[] }>(list: T[], host: string): T | undefined;
export function platformForHost(list: Sources | { hosts: string[] }[], host: string): unknown {
  const items = Array.isArray(list) ? list : allPlatforms(list);
  const h = host.toLowerCase().replace(/^www\./, '');
  return items.find((p) =>
    p.hosts.some((pattern) => {
      const pat = pattern.toLowerCase();
      if (pat.startsWith('*.')) return h === pat.slice(2) || h.endsWith(pat.slice(1));
      return h === pat || h.endsWith(`.${pat}`);
    }),
  );
}
