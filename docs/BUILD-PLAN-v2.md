# Build plan: SriLankanJobs Agent v2

The spec is `docs/PRD-v2-resume-to-jobs.md`. This file says who builds what, in what order, and the contracts between the pieces. Where this file and the PRD disagree on *what* to build, the PRD wins. Where they disagree on *file ownership or interfaces*, this file wins.

## 1. Order of work

| Wave | Stream | Scope | PRD |
| --- | --- | --- | --- |
| 0 | **F0 Foundation** (alone) | Repo cleanup, dependencies, paths, config, DB migration, shared types, stubs so every later stream starts from a green typecheck and test run | §2, §6, §9 |
| 1 | **S1 Fetch** | `src/sources/http.ts`, `fetch-ladder.ts`, cache, wiring `browser.ts` as T2/T3, first live run of `browser.ts` | §7.2 (http), §7.3, §7.4 |
| 1 | **S2 Pipeline** | identity, description cleaner, places, salary/date rules, store changes, `jobs scan`, `jobs recheck`, `sources doctor`, scan status files, `modes/scan.md` | §5.2, §7.2 |
| 1 | **S3 Boards A** | adapters: `xpressjobs`, `ikman`, `topjobs` | §7.1 |
| 1 | **S4 Boards B** | adapters: `hotjobs`, `jobeka`, `rooster` | §7.1 |
| 1 | **S5 Boards C** | adapters: `itpro`, `careers360`, `jobber`, `jobsnet`, `dreamjobs`, `governmentjobs` | §7.1 |
| 1 | **S6 ATS** | adapters: `workday`, `greenhouse`, `lever`, `ashby`, `smartrecruiters`; `config/boards.json`; `boards check` | §7.1 |
| 1 | **S7 Resume import** | `resume import`, vision fallback, `modes/import.md` | §5.1 |
| 1 | **S8 Match** | `match prefilter`, `score save`, `top`, paging and widening, `modes/score.md`, `modes/report.md` | §5.3, §5.4, §5.4a |
| 1 | **S9 CV** | vendored resume skill, templates, `cv render`, `cv ats-check`, `factcheck`, watermark, `modes/tailor.md`, golden test | §5.5, §8 |
| 2 | **I1 Integration** | Full typecheck and test run, fix the seams between streams, live end-to-end scan, record verified tiers in `sources.yml` | §11 gates |
| 3 | **D1 Agent wiring and docs** | `AGENTS.md`, router skill, per-agent pointers, `README`, `CONTRIBUTING`, `LICENSE`, issue template, headless run | §6, M4 |

## 2. Rules for every stream

1. **Stay in your files.** §4 lists who owns what. Do not edit a file another stream owns. If you need something from it, work around it locally and say so in your final report.
2. **Frozen files:** `src/sources/types.ts`, `src/sources/util.ts`, `src/user/profile.ts`, `src/paths.ts`, `src/errors.ts`, `src/registry.ts`, `src/context.ts`, `src/commands/index.ts`, `package.json`. Only F0 and I1 edit them. All dependencies are installed by F0; do not run `npm install <pkg>`. If you truly need another package, say so in your final report and code without it.
3. **Other streams are working in this tree at the same time.** `npm run typecheck` may show errors in files that are not yours: ignore those, fix every error in yours. Run only your own tests (`node --test test/<yours>.test.ts`), not the whole suite.
4. **Do not commit, stash, reset or check out.** Leave your work in the working tree.
5. **Code style:** match the existing code. TypeScript run directly by Node (type stripping): `.ts` import extensions, `erasableSyntaxOnly` (no enums, no parameter properties), `import type` for types. Tests use `node:test` and `node:assert/strict`.
6. **Every command** is a `defineCommand` in the registry with a zod input, returns plain JSON, throws `SljError` for expected failures, and has a `format` for people. CLI and MCP come from the same registry for free.
7. **Network in tests is forbidden.** Tests run on fixtures. Fixtures are trimmed snippets, not whole pages (PRD §7.5).
8. **Live sites:** one request at a time per host, at least 1.5 s apart, a few dozen requests per site at most while you learn its structure. If a site shows a human check, stop and record it; never work around it. None of the excluded tools in PRD §7.5 may appear in code.
9. **Personal data** stays in `user/` (`ctx.paths.userDir`). Nothing there is ever deleted by a build step.
10. **Final report** (your last message): what you built, what you verified and how, what is not done or not verified, and anything another stream needs to know. State failures plainly.

## 3. Contracts

### 3.1 Shared types (`src/sources/types.ts`, created by F0 exactly as below)

```ts
import type { JobFields } from '../jobs/schema.ts';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';
export type BlockReason = 'http' | 'challenge' | 'login' | 'drift' | 'timeout' | 'gave_up' | 'error';

export interface HttpResponse {
  status: number;
  url: string;                       // final URL after redirects
  headers: Record<string, string>;   // lower-cased names
  text: string;
}
export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  delayMs?: number;                  // per-host minimum gap for this call; default from the source config
}
/** The one HTTP door. Resolves for any status the server returns; callers check `.status`.
 *  Rejects with SljError('FETCH_FAILED') only when the network fails after retries. */
export interface HttpClient {
  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  postJson(url: string, body: unknown, opts?: HttpRequestOptions): Promise<HttpResponse>;
}

export interface PageRequest {
  kind?: 'listing' | 'detail';       // picks the cache TTL: listing 6 h, detail 24 h
  waitFor?: string;                  // CSS selector, browser tiers only
  scroll?: number;                   // browser tiers only
  /** Returns false when the page loaded but is not what the adapter expected (selector drift, soft block). */
  expect?: (html: string) => boolean;
  noCache?: boolean;
}
export interface PageResult {
  ok: boolean;
  url: string;
  finalUrl: string;
  status: number | null;
  html: string;                      // '' when !ok
  jsonLd: unknown[];                 // every parsed <script type="application/ld+json"> block
  tier: Tier;                        // the tier that produced this result
  staleAgeS?: number;                // set when served from the T5 last-good cache
  block?: { reason: BlockReason; detail: string };
}
/** Tries the source's tiers in order for one URL. Never throws for a blocked page: returns ok=false. */
export interface Ladder {
  page(url: string, req?: PageRequest): Promise<PageResult>;
  /** The weakest (highest-numbered) tier any page needed so far in this run. */
  worstTier(): Tier;
}

export type ScrapedJob = JobFields & { source_url: string; external_id: string };

export interface SourceConfig {
  id: string;
  name: string;
  kind: 'board' | 'ats' | 'government';
  hosts: string[];
  enabled: boolean;
  slow: boolean;                     // runs only on request (PRD §5.4a step 3)
  tiers: Tier[];
  max_details: number;
  delay_ms: number;
  options: Record<string, unknown>;
}
export interface SourceContext {
  source: SourceConfig;
  http: HttpClient;
  ladder: Ladder;
  now(): Date;
  since: Date | null;                // skip jobs posted before this when the site gives a posted date
  /** True when an earlier scan already stored this external id: skip its detail fetch. */
  seen(externalId: string): boolean;
  log(message: string): void;        // progress line on stderr
  boards: Record<string, unknown[]>; // config/boards.json, keyed by ATS family
}
export interface SourceResult {
  jobs: ScrapedJob[];
  listed: number;                    // entries found on listings before any detail fetch
  skippedSeen: number;
  deferred: string[];                // external ids whose detail fetch failed (PRD §7.2 defer_job)
}
export type Liveness = 'alive' | 'closed' | 'unknown';   // unknown is treated as alive
export interface SourceAdapter {
  id: string;
  scan(ctx: SourceContext): Promise<SourceResult>;
  recheck(job: { source_url: string; external_id: string }, ctx: SourceContext): Promise<Liveness>;
}
```

- An adapter lives at `src/sources/<id>/index.ts` and **default-exports** a `SourceAdapter`. Pure parsing goes in `src/sources/<id>/parse.ts` so it can be tested on fixtures in `src/sources/<id>/fixtures/`. Tests go in `test/sources-<id>.test.ts`.
- `src/sources/load.ts` (F0) loads an adapter by id with a dynamic import of `./<id>/index.ts`. There is no central list to edit.
- An adapter throws only for a whole-source failure (listing unreachable on every tier). One bad detail page goes in `deferred`. A whole-source failure is caught by `jobs scan` and logged as `PARTIAL`.
- `external_id` is the site's own posting id (from the URL or the API), stable across scans. It is identity tier 1.
- Adapters fill structured fields from JSON-LD or API fields first and only fill nulls from text (PRD rules 9 and 11). They pass description HTML through `cleanDescription` (S2) when it exists; until then they return the raw description HTML/text and `jobs scan` cleans it. **Decision: `jobs scan` always cleans; adapters return the description as the site gives it (HTML or text).**
- Adapters request pages only through `ctx.ladder.page()` (HTML) or `ctx.http` (JSON APIs, sitemaps). Never `fetch` directly.
- `src/sources/util.ts` (F0): `mapInOrder(items, fn, workers)`, results in input order. `test/source-helpers.ts` (F0): `fixtureContext({ pages, json, source })` builds a `SourceContext` whose ladder and http serve from maps and record calls.

### 3.2 S1 exports (`src/sources/http.ts`, `src/sources/fetch-ladder.ts`)

```ts
// http.ts
export function createHttpClient(opts: { fetch?: typeof fetch; defaultDelayMs?: number; userAgent?: string; sleep?: (ms: number) => Promise<void>; now?: () => number }): HttpClient;
// fetch-ladder.ts
export function createLadder(opts: {
  source: SourceConfig; http: HttpClient; cacheDir: string; userDir: string; now: () => Date;
  log: (m: string) => void; browser?: BrowserLike;   // injectable for tests; default wraps browser.ts
}): Ladder & { close(): Promise<void> };
export function detectBlock(res: { status: number | null; html: string; finalUrl: string }): { reason: BlockReason; detail: string } | null;
```

T4 and T6 are not code paths in the ladder: they are the agent's job (`modes/scan.md`) and end in `slj jobs add`. The ladder handles T0/T1 (http), T2/T3 (browser), T5 (last good cache).

### 3.3 S2 exports

```ts
// src/jobs/identity.ts
export function identityKeys(job: { platform: string; external_id?: string | null; company?: string | null; title: string; location?: string | null; apply_url?: string | null }): { tier1: string | null; tier1b: string | null; tier2: string | null };
// src/jobs/clean.ts
export function cleanDescription(htmlOrText: string): string;        // → Markdown, keep-list tags, no attributes
// src/jobs/places.ts
export function parsePlace(location: string | null | undefined): { district: string | null; slug: string | null; remote: boolean };
// src/sources/scan.ts
export async function runScan(ctx: Context, opts: { sources?: string[]; sinceDays?: number; includeSlow?: boolean }): Promise<ScanReport>;
```

Commands: `jobs scan [--sources a,b] [--since 14d] [--slow]`, `jobs recheck --top | --ids a,b`, `sources doctor [--report]`. `jobs list` / `jobs get` / `jobs add` (with `--html`) stay, owned by S2 after F0.

### 3.4 User files (`src/user/profile.ts`, F0)

- `user/resume.md`: source of truth. `resumeHash(ctx)` = sha256 of its bytes, first 16 hex chars.
- `user/profile.yml`: every field is `{ value, inferred }`. Fields: `name`, `target_titles` (≤3), `adjacent_titles`, `seniority` (`intern|junior|mid|senior|lead|manager|executive`), `years_experience`, `skills`, `location`, `districts_ok`, `work_mode` (`any|onsite|hybrid|remote`), `salary_floor` (optional), `cv_style` (`modern|traditional`). `loadProfile(ctx)`, `ProfileSchema`.
- `user/facts.yml`: list of `{ id, text, kind, source: 'interview', confirmed: true, added_at }`. `loadFacts(ctx)`, `FactsSchema`.
- `user/stats.json`: `bumpStat(ctx, 'scans' | 'top_reports' | 'cvs')`. Never uploaded.

### 3.5 Commands across streams

| Command | Owner | Returns (data) |
| --- | --- | --- |
| `resume import <file>` | S7 | `{ status: 'ok' \| 'NEEDS_VISION', method, raw_path, images: [], resume_path }`; writes `user/resume.raw.md`, records `resumes` |
| `resume status` | S7 | whether `resume.md` and `profile.yml` exist and validate, `resume_hash` |
| `match prefilter --limit 60 --offset 0 [--titles] [--district] [--remote] [--like <job>] [--since]` | S8 | ranked candidates not yet scored for this `(resume_hash, rubric_version)`, each with a requirements excerpt ≤1,500 chars |
| `score save` (`--input` with a batch) | S8 | validates rubric points, derives stars, applies caps, stores |
| `top --limit 20 --offset 0` | S8 | ranked rows with `n` (#), stars, job, why; writes or appends `user/reports/<date>-top20.md`; records `top_reports` |
| `top why <n>` / `top resolve <n>` | S8 | full rubric breakdown / the job id behind `#n` |
| `cv render --job <id> --style modern\|traditional` | S9 | paths, page count, watermark state |
| `cv ats-check --job <id>` | S9 | table of name/email/phone/keywords found in the PDF text layer |
| `factcheck --job <id>` | S9 | pass/fail with every unsupported claim |
| `facts add` | S9 | appends a confirmed interview fact to `facts.yml` |
| `boards check <board>` | S6 | validity and count of Sri Lanka postings |

Stars come from one place: `starsFromPoints(points)` in `src/match/stars.ts` (S8), bands from `config/settings.yml`.

### 3.6 Database (migration 2, F0)

Keeps `jobs`, `job_sources`, `runs`, `audit`, `kv`. Drops `applications`, `emails`, `events`, `portal_accounts`, `qa` and the old `scores`. Adds to `jobs`: `external_id`, `country_code`, `remote`, `employment_type`, `scraped_at`, `district`, `identity_t1`, `identity_t1b`, `identity_t2` (indexed), `closed_at`, `closed_reason`. Adds tables `resumes`, `scores`, `top_reports`, `source_runs`, `seen`, `cv_outputs` with the columns in PRD §9; `scores` is unique on `(job_id, resume_hash, rubric_version)` and also stores `breakdown_json` (per-dimension points and per-requirement met/partial/missing with the quoted JD phrase).

A stream that needs another column appends a migration to `src/db/migrations.ts` with the Edit tool, using its own version range: S2 10–19, S7 20–29, S8 30–39, S9 40–49, S6 50–59.

## 4. File ownership

| Stream | Owns |
| --- | --- |
| F0 | Frozen files (§2.2), `src/config.ts`, `src/db/*`, `src/jobs/schema.ts`, `src/sources/load.ts`, `config/*`, `test/helpers.ts`, `test/source-helpers.ts`, `modes/_shared.md`, deletions |
| S1 | `src/sources/http.ts`, `fetch-ladder.ts`, `cache.ts`, `browser.ts`, `test/http.test.ts`, `test/ladder.test.ts`, `test/browser-detect.test.ts` |
| S2 | `src/jobs/*` except `schema.ts`, `src/sources/scan.ts`, `src/sources/status.ts`, `src/commands/jobs.ts`, `src/commands/sources.ts`, `modes/scan.md`, their tests |
| S3–S5 | `src/sources/<their ids>/`, `test/sources-<id>.test.ts`, their own entry in `config/sources.yml` (Edit that entry only) |
| S6 | `src/sources/{workday,greenhouse,lever,ashby,smartrecruiters}/`, `src/sources/ats-common.ts`, `config/boards.json`, `src/commands/boards.ts`, their tests, their `sources.yml` entries |
| S7 | `src/resume/*`, `src/commands/resume.ts`, `modes/import.md`, `test/resume-*.test.ts`, `test/fixtures/resume/` |
| S8 | `src/match/*`, `src/commands/match.ts`, `modes/score.md`, `modes/report.md`, `test/match-*.test.ts` |
| S9 | `src/cv/*`, `src/commands/cv.ts`, `templates/*`, `.agents/skills/resume-tailor/`, `modes/tailor.md`, `test/cv-*.test.ts`, `test/fixtures/cv/` |
| D1 | `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, `OPENCODE.md`, `.agents/skills/slj/`, `.claude/`, `.cursor/`, `.github/`, `README.md`, `CONTRIBUTING.md`, `LICENSE` |

F0 creates each `src/commands/<stream>.ts` as a stub exporting an empty `Command[]` (`resumeCommands`, `sourcesCommands`, `boardsCommands`, `matchCommands`, `cvCommands`) and registers them in `src/commands/index.ts`. Streams fill their own array.

## 5. What cannot be verified by a build agent

These PRD gates need people or many real CVs. Build the harness, run what can be run, and report the rest as open:

- 30-job hand-labelled star agreement (M2). Build the comparison script and the file format; the labels come from a recruiter.
- 50 generated CVs with zero invented facts (M3). The golden test (5 CVs × 3 JDs) stands in.
- The same top 20 in 4 agents (M4). Only Claude Code can be run here.
- PDF opening on Windows.
