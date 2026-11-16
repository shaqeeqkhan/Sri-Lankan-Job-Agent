# Contributing

Most contributions are job sources: a new Sri Lankan site, an employer's career board, or a fix for a site that changed its pages. This file covers those. For the agent's behaviour, see [AGENTS.md](AGENTS.md) and [`modes/`](modes/); for the design and its reasons, [docs/PRD-v2-resume-to-jobs.md](docs/PRD-v2-resume-to-jobs.md) §7.

## Setup

```sh
npm install
npm run typecheck
npm test                     # node:test; no network. PDF tests use Chrome or Edge if installed, else they skip
SLJ_NO_BROWSER=1 npm test    # what CI runs: skips the PDF tests that need Chrome, Edge or Chromium
SLJ_BROWSER_TEST=1 npm test  # also runs the opt-in live human-check test (opens a visible Chrome window for ~25 s)
```

Node 22.18+ runs the TypeScript directly; there is no build step. Run anything that writes data against a scratch folder, never your own `user/`:

```sh
SLJ_HOME=$(mktemp -d) ./slj jobs scan --sources mysite --json
```

**Windows:** `.claude/skills` is a symbolic link to `.agents/skills`. Enable Developer Mode (or run Git as administrator) and `git config --global core.symlinks true` before cloning, or Claude Code will not see the skills. Nothing else needs symlinks.

## Adding a job site

A source is one folder, `src/sources/<id>/`, plus one entry in `config/sources.yml`. There is no central list to register in: `slj jobs scan` loads `src/sources/<id>/index.ts` for each entry.

1. **Look at the site first.** In order of preference: an ATS JSON API, RSS, `sitemap.xml`, `JobPosting` JSON-LD in the job pages, the front end's own JSON endpoints, then plain HTML. Structured data survives redesigns. Write down what you found; it goes in `notes`.

2. **`src/sources/<id>/parse.ts`**: pure functions only (HTML/JSON in, fields out), no network. Typically `parseListing()`, `parseDetail()` and `externalIdFromUrl()`. Rules carried over from ThreatHire:
   - **A wrong value is worse than a missing one.** An ambiguous date (`03/04`) is `null`, not a guess. Parse a salary only when the currency and figure are unambiguous.
   - **A structured field always wins.** A closing date, salary or location from JSON-LD or an API field is never overwritten by a text parser; text parsing only fills nulls.
   - Pass descriptions through as HTML; `jobs scan` cleans them through a keep-list (`src/jobs/clean.ts`) before an AI ever reads them.
   - Image-only ads: set `is_image_ad: true` and put the image URL in the description, so the agent reads it with vision.
   - Keep foreign postings' real `country_code`; the scan drops non-LK jobs.

3. **`src/sources/<id>/index.ts`**: default-export a `SourceAdapter` (`src/sources/types.ts`) with `id` equal to the folder name, `scan(ctx)` and `recheck(job, ctx)`.
   - Fetch only through `ctx.ladder.page()` (HTML, with the fallback tiers) or `ctx.http` (JSON/XML). Never import `fetch`, undici or Playwright directly: those two are the one door that applies pacing, caching, retries and block detection.
   - Pass `kind: 'listing'` or `'detail'` (cache lifetime) and an `expect(html)` check so a soft block or a redesigned page is detected as a failure instead of "0 jobs".
   - Skip detail fetches for `ctx.seen(external_id)`, newest first. Stop at `source.max_details`, and honour `ctx.deadline` (the per-source time budget, `settings.scan.source_budget_s`) through the `detailBudget(ctx)` helper in `src/sources/util.ts`: no new detail page starts after it.
   - Return a `SourceResult` (`src/sources/types.ts`): `jobs`, `listed`, `skippedSeen`, `deferred`, and the optional `truncated` and `dropped`.
   - **A failed detail fetch defers the job** (its id goes in `deferred`); it is never stored with thin data, is not marked seen, and is retried on the next scan.
   - **`dropped`**: ids whose detail page *was* read but showed a job not worth storing (expired, closed, gone, overseas, older than `since`). They are marked seen so they are not fetched again every scan. Never put a failed fetch here.
   - **`truncated`** (`{ reason: 'time' | 'max_details', left }`): set it when you stopped before the candidates ran out. Those jobs are not marked seen; the next scan takes the next batch. `jobs scan` and `sources doctor` report it.
   - `scan()` may throw for a listing that cannot be read at all. The scan marks the source `partial` and carries on; one broken site never stops the others.

4. **Identity.** Every job needs a stable `external_id`: the site's own posting id (from the URL or the data), never a row number or a hash of the title. It is tier 1 of the dedupe key (`platform|external_id`, `src/jobs/identity.ts`). If the site links to an employer ATS (Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Workable), keep the real apply link: `postingRef()` recognises it and merges copies of the same posting across sites. A new ATS URL pattern goes in `identity.ts` with a row in `test/identity.test.ts`. Do not change tier 2 (company + title + place) casually: it re-keys every stored job, and its test is there to stop that.

5. **Liveness.** `recheck()` returns `'alive'`, `'closed'` or `'unknown'` for one stored job. Return `'closed'` only on a clear signal: a 404/410 the site really uses, the site's own expired or closed flag, a closing date that has passed. Anything unclear is `'unknown'`, which counts as alive (most sites soft-404). **A source is not done until `jobs recheck` can check it too.**

6. **Fixtures**: `src/sources/<id>/fixtures/`, trimmed to the minimum that exercises the parser: the one `<script>` block or table rows you read, two or three listing entries, one or two detail pages (one open, one closed or odd). Not whole pages: the repo must not redistribute sites' content. Swap any real person's name, phone number or email in an ad for an invented one.

7. **Test**: `test/sources-<id>.test.ts`. Use `readFixture('<id>', '<file>')` and `fixtureContext()` from `test/source-helpers.ts`, which serves your fixtures to `ctx.ladder` and `ctx.http` with no network and records every call. Cover at least: external ids from URLs (including tracking parameters and non-job links), the listing parse, a full detail parse with every field asserted, an expired or removed job, a `scan()` run through `fixtureContext` (seen jobs skipped, `max_details` respected, a failed detail deferred, an expired detail dropped, truncation reported), and `recheck()` for alive, closed and unknown. Copy `test/sources-hotjobs.test.ts` as a starting point.

8. **`config/sources.yml` entry** (validated by zod at start-up; a bad entry stops the scan with `CONFIG_INVALID`):

   ```yaml
   - id: mysite                 # = folder name
     name: MySite.lk
     kind: board                # board | ats | government
     priority: P2
     hosts: [mysite.lk]
     enabled: true
     slow: true                 # true: runs only on "more jobs" widening, --slow or --sources
     tiers: [T0, T1, T5]        # T0 structured, T1 HTTP, T2 headless Chrome, T3 visible Chrome + human check, T5 last good cache
     max_details: 300
     delay_ms: 1500             # per-host gap; at least 1000 for HTML sites
     options: {}                # whatever your adapter reads from ctx.source.options
     notes: >-
       Verified <date>: what the listing and detail pages are, what a closed job looks like,
       whether plain HTTP works.
   ```

   **Order matters: the list order is dedupe precedence.** When two sources carry the same job, the first one in the list wins (its salary, closing date, description). ATS families come first, then XpressJobs, then the other boards, government last (`test/sources-core.test.ts` checks this). Put a new board where its data quality fits, usually near the end of the boards, and say why in the PR. New sites start as `slow: true` unless they are large, fast and reliable.

9. **Run it live once**, against a scratch `SLJ_HOME`: `./slj jobs scan --sources mysite --json`, then `./slj jobs recheck --ids <a few ids> --json` and `./slj sources doctor --source mysite --json`. Put the counts in the PR. A normal scan has to stay under about 3 minutes in total, so keep `max_details` modest.

## Adding an employer's career board

Employers on Workday, Greenhouse, Lever, Ashby or SmartRecruiters are listed in `config/boards.json`. A board is added only if it is **advertising Sri Lanka-based roles at the moment it is checked**:

```sh
./slj boards check "https://careers.example.com/..." --company "Example PLC" --json         # a careers link
./slj boards check "tenant|wd3|Site" --family workday --company "Example PLC" --json         # Workday
./slj boards check example --family greenhouse --company "Example" --add --json               # appends if it qualifies
```

`--add` appends the board only when its API answers and it has Sri Lanka postings right now; otherwise it says why. Commit the `boards.json` change with the count it reported.

## Fixing a broken site

Issues for broken sites come with `slj sources doctor --report` output: the source, the tier, status, HTTP status, listed/parsed counts and whether it was "low" (0 jobs, or under 30% of its recent median). It contains no personal data.

1. Reproduce: `SLJ_HOME=$(mktemp -d) ./slj jobs scan --sources <id> --json`.
2. Find what changed. 0 parsed from a large page is selector drift; a challenge or 403 is a block (see below, it is not a parser fix); a soft 404 is a liveness change.
3. Save a new trimmed fixture of the changed page next to the old one, add a failing test for it, then fix `parse.ts`. Keep the old fixture's test unless the old layout is truly gone.
4. Update the source's `notes` with the date and what changed.

## Lines that stay out of the code

robots.txt is not consulted, and people complete human checks themselves in a visible browser window. These stay out at every tier, and PRs that add them will be closed:

- CAPTCHA-solving services or models;
- rotating or residential proxies;
- stealth or fingerprint-spoofing plugins, or faked user agents to dodge a block;
- signing in with stored passwords;
- parallel requests to one host (sources run in parallel with each other; one host is always one request at a time);
- anything that applies, emails or submits on the person's behalf.

Why: every request comes from the person's own home or mobile connection, often shared through their ISP. Pacing plus a human solving the occasional check looks like someone browsing; evasion tooling does not, and the block lands on everyone sharing that connection. And this is open source under a real name: polite scraping that hands checks to a human is defensible; shipping bypasses for local job boards is not. A site that blocks plain HTTP gets the browser tiers (T2/T3) and, failing that, the person pastes the ad.

## Checking star accuracy (`slj match eval`)

A recruiter labels about 30 scored jobs for one CV. Save the labels as CSV:

```
# job_id,human_stars[,note]   (header and # comments are optional)
job_id,human_stars
jc88428535ae,5
jc4fac6a0638,3,no SSIS
```

or as JSON: `[{ "job_id": "jc88428535ae", "human_stars": 5 }]`. Then run `./slj match eval --labels <file> --json`. It reads the saved stars for the current `user/resume.md` (or `--resume-hash`) and rubric, and reports the share within ±1 star, the exact share, the mean difference, unscored ids and every miss. It passes at **85% within ±1 over at least 30 jobs**. Run it again whenever `modes/score.md` changes, and bump `rubric_version` in `config/settings.yml` when the rubric itself does.

## Keeping AI usage low

People run this on small plans and small models, so the instructions and the tool output are budgeted:

- `AGENTS.md` is loaded on every turn of every session. Keep it short; put step detail in the mode file for that step.
- `--json` output is one line with no indentation, and commands return only what the next step needs (`match prefilter` hands out `score_batch` lean candidates per call; `top --brief` returns the page ready to show). Put debugging detail behind a flag (`--explain`), not in the default result.
- Do not make an agent write something code can derive (`matched` comes from the requirements marked `met`).
- Anything vendor-specific that saves usage (the `slj-scorer` worker in `.claude/agents/`) is optional and must give the same result as the plain path.

## Fixtures and personal data

- Source fixtures: minimal snippets, never whole pages.
- CV fixtures (`test/fixtures/cv/`, `test/fixtures/resume/`): invented people only. Never commit a real CV, even with permission, and never anything from a `user/` folder.
- `sources doctor --report` output is safe to paste; scan logs and `user/` files are not.

## Before you open a PR

```sh
npm run typecheck
SLJ_NO_BROWSER=1 npm test
```

CI runs the same two commands on Node 22.18 (`.github/workflows/ci.yml`). If you changed a command's options, check that `AGENTS.md` still documents it (`test/registry.test.ts` fails otherwise).

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
