/**
 * Integration (I1): the seams between streams, each crossing two modules that were built and tested
 * apart. No network: the real HTTP client and ladder run over a stub fetch.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scoreSave, topCmd } from '../src/commands/match.ts';
import { jobsRecheck } from '../src/commands/sources.ts';
import { keywordsFromScore } from '../src/cv/ats-check.ts';
import { isForeignJob, isForeignPlace } from '../src/jobs/places.ts';
import { execute } from '../src/registry.ts';
import { createLadder } from '../src/sources/fetch-ladder.ts';
import { createHttpClient } from '../src/sources/http.ts';
import { latestTopJobIds, runScan, type LadderFactoryOptions, type ScanDeps } from '../src/sources/scan.ts';
import type { ScrapedJob, SourceAdapter, SourceContext, SourceResult } from '../src/sources/types.ts';
import { detailBudget } from '../src/sources/util.ts';
import { ROOT, makeCtx, stubFetch, tempDir } from './helpers.ts';
import { item, matchCtx, run, seedMany } from './match-fixture.ts';

const NOW = new Date('2026-11-15T04:00:00Z');

function configDir(settingsOver: (s: string) => string = (s) => s): string {
  const dir = tempDir('slj-int-config-');
  fs.writeFileSync(path.join(dir, 'settings.yml'), settingsOver(fs.readFileSync(path.join(ROOT, 'config', 'settings.yml'), 'utf8')));
  fs.copyFileSync(path.join(ROOT, 'config', 'boards.json'), path.join(dir, 'boards.json'));
  const src = (id: string, maxDetails = 300) =>
    `  - {id: ${id}, name: Source ${id}, kind: board, priority: P1, hosts: [${id}.example], enabled: true, slow: false, tiers: [T0, T1, T5], max_details: ${maxDetails}, delay_ms: 1000, options: {}}`;
  fs.writeFileSync(path.join(dir, 'sources.yml'), ['sources:', src('a'), src('b', 3), 'platforms: []', ''].join('\n'));
  return dir;
}

function sj(source: string, id: string, over: Partial<ScrapedJob> = {}): ScrapedJob {
  return {
    title: `Data Analyst ${id}`,
    company: `Company ${id}`,
    location: 'Colombo 03',
    closing_date: '2026-11-30',
    description: '<p>SQL and Power BI.</p>',
    apply_email: `jobs.${id}@example.lk`,
    source_url: `https://${source}.example/jobs/${id}`,
    external_id: id,
    ...over,
  };
}

const adapters = (scans: Record<string, (ctx: SourceContext) => Promise<SourceResult>>) => async (id: string): Promise<SourceAdapter> => {
  const scan = scans[id] ?? (async () => ({ jobs: [], listed: 0, skippedSeen: 0, deferred: [] }));
  return { id, scan, recheck: async () => 'unknown' };
};

// ---------------------------------------------------------------- overseas jobs

test('isForeignPlace: clearly foreign places are dropped; Sri Lankan and unknown places are kept', () => {
  for (const l of ['Muscat, Oman', 'Dubai - UAE', 'Riyadh, Saudi Arabia', 'Doha', 'Foreign Job', 'Global Worldwide', 'Middle East', 'Male, Maldives', 'Ajman'])
    assert.equal(isForeignPlace(l), true, l);
  for (const l of ['Colombo 03', 'Colombo or Dubai', 'Remote', 'Island wide', 'Hatton', 'Udugampola', 'Dubai Road, Kadawatha', 'Sri Lanka', '', null])
    assert.equal(isForeignPlace(l), false, String(l));
  assert.equal(isForeignJob({ country_code: 'OM', location: 'Colombo' }), true, 'a non-LK country code wins');
  assert.equal(isForeignJob({ country_code: null, location: 'Udugampola' }), false, 'null country alone says nothing');
  assert.equal(isForeignJob({ country_code: 'LK', location: 'Global Worldwide' }), true, 'JobEka labels everything LK');
});

test('jobs scan stores no overseas job, counts them as skipped_foreign and does not refetch them', async () => {
  const ctx = makeCtx({ now: NOW, configDir: configDir() });
  const jobs = [
    sj('a', '1'),
    sj('a', '2', { country_code: 'AE', location: 'Dubai' }),
    sj('a', '3', { country_code: null, location: 'Muscat, Oman' }),
    sj('a', '4', { country_code: 'LK', location: 'Global Worldwide' }),
    sj('a', '5', { location: 'Udugampola' }),
  ];
  const seenSeen: string[] = [];
  const deps: ScanDeps = {
    log: () => {},
    makeHttp: () => ({ get: async (url) => ({ status: 404, url, headers: {}, text: '' }), postJson: async (url) => ({ status: 404, url, headers: {}, text: '' }) }),
    makeLadder: () => ({ page: async (url) => ({ ok: false, url, finalUrl: url, status: 404, html: '', jsonLd: [], tier: 'T1' }), worstTier: () => 'T1' }),
    loadAdapter: adapters({
      a: async (c) => {
        const fresh = jobs.filter((j) => !c.seen(j.external_id));
        seenSeen.push(...jobs.filter((j) => c.seen(j.external_id)).map((j) => j.external_id));
        return { jobs: fresh, listed: jobs.length, skippedSeen: jobs.length - fresh.length, deferred: [] };
      },
    }),
  };
  const r = await runScan(ctx, { sources: ['a'] }, deps);
  const a = r.sources.find((s) => s.id === 'a')!;
  assert.equal(a.skipped_foreign, 3);
  assert.equal(a.inserted, 2);
  assert.equal(r.totals.skipped_foreign, 3);
  const stored = ctx.db().prepare('SELECT location FROM jobs ORDER BY location').pluck().all();
  assert.deepEqual(stored, ['Colombo 03', 'Udugampola']);
  await runScan(ctx, { sources: ['a'] }, deps);
  assert.deepEqual(seenSeen.sort(), ['1', '2', '3', '4', '5'], 'foreign ones are marked seen too');
});

// ---------------------------------------------------------------- time budget

test('detailBudget stops on max_details or the deadline and counts what was left', () => {
  const src = { id: 's', max_details: 3 } as SourceContext['source'];
  const logs: string[] = [];
  const b = detailBudget({ source: src, log: (m: string) => logs.push(m) } as unknown as SourceContext);
  assert.deepEqual([1, 2, 3, 4, 5].map(() => b.take()), [true, true, true, false, false]);
  assert.deepEqual(b.truncation(), { reason: 'max_details', left: 2 });

  let t = 0;
  const timed = detailBudget({ source: { ...src, max_details: 100 }, deadline: 10, log: (m: string) => logs.push(m) } as unknown as SourceContext, () => t);
  assert.equal(timed.take(), true);
  t = 10;
  assert.equal(timed.take(), false);
  assert.equal(timed.take(), false);
  assert.deepEqual(timed.truncation(), { reason: 'time', left: 2 });
  assert.equal(timed.used, 1);
  assert.equal(detailBudget({ source: src, log: () => {} } as unknown as SourceContext).truncation(), undefined);
});

test('jobs scan gives each source a deadline from settings.scan.source_budget_s and reports truncation; leftovers are retried', async () => {
  const ctx = makeCtx({ now: NOW, configDir: configDir((s) => s.replace(/source_budget_s: \d+/, 'source_budget_s: 60')) });
  const deadlines: (number | undefined)[] = [];
  const all = ['1', '2', '3', '4', '5'].map((id) => sj('b', id));
  let cut = true;
  const deps: ScanDeps = {
    log: () => {},
    makeHttp: () => ({ get: async (url) => ({ status: 404, url, headers: {}, text: '' }), postJson: async (url) => ({ status: 404, url, headers: {}, text: '' }) }),
    makeLadder: () => ({ page: async (url) => ({ ok: true, url, finalUrl: url, status: 200, html: '', jsonLd: [], tier: 'T1' }), worstTier: () => 'T1' }),
    loadAdapter: adapters({
      b: async (c) => {
        deadlines.push(c.deadline);
        // The first scan's clock runs out after two detail pages.
        let n = 0;
        const budget = detailBudget(c, () => (cut && n >= 2 ? Number.MAX_SAFE_INTEGER : 0));
        const jobs: ScrapedJob[] = [];
        let skippedSeen = 0;
        for (const j of all) {
          if (c.seen(j.external_id)) {
            skippedSeen++;
            continue;
          }
          if (!budget.take()) continue;
          n++;
          jobs.push(j);
        }
        return { jobs, listed: all.length, skippedSeen, deferred: [], truncated: budget.truncation() };
      },
    }),
  };
  const t0 = Date.now();
  const r1 = await runScan(ctx, { sources: ['b'] }, deps);
  const b1 = r1.sources[0];
  assert.ok(deadlines[0]! >= t0 + 60_000 && deadlines[0]! <= Date.now() + 60_000, 'deadline = start + budget');
  assert.equal(b1.inserted, 2);
  assert.deepEqual([b1.truncated, b1.truncated_reason, b1.truncated_left], [true, 'time', 3]);
  cut = false;
  // max_details for b is 3: the next scan takes the next three (not marked seen), so nothing is left.
  const r2 = await runScan(ctx, { sources: ['b'] }, deps);
  assert.equal(r2.sources[0].inserted, 3);
  assert.equal(r2.sources[0].truncated, false);
  assert.equal(r2.open_jobs, 5);
});

// ---------------------------------------------------------------- real HTTP door + ladder

test('jobs scan wires the real HTTP client and ladder: injected fetch, cache TTLs, per-source delay, close() always', async () => {
  const { fetch, calls } = stubFetch({ 'https://a.example/list': '<html><body>list page</body></html>' });
  const ctx = makeCtx({ now: NOW, configDir: configDir(), fetch });
  const ladderOpts: LadderFactoryOptions[] = [];
  const closed: string[] = [];
  const delays: (number | undefined)[] = [];
  const deps: ScanDeps = {
    log: () => {},
    makeHttp: (o) => {
      const h = createHttpClient(o);
      return {
        get: (url, opts) => (delays.push(opts?.delayMs), h.get(url, opts)),
        postJson: h.postJson,
        close: async () => (closed.push('http'), h.close()),
      };
    },
    makeLadder: (o) => {
      ladderOpts.push(o);
      const l = createLadder(o);
      return { page: l.page, worstTier: l.worstTier, close: async () => (closed.push(`ladder:${o.source.id}`), l.close()) };
    },
    loadAdapter: adapters({
      a: async (c) => {
        const page = await c.ladder.page('https://a.example/list', { kind: 'listing' });
        assert.equal(page.ok, true);
        assert.match(page.html, /list page/);
        return { jobs: [sj('a', '1')], listed: 1, skippedSeen: 0, deferred: [] };
      },
      b: async () => {
        throw new Error('listing unreachable');
      },
    }),
  };
  const r = await runScan(ctx, {}, deps);
  assert.deepEqual(calls, ['https://a.example/list'], 'the stub fetch was the one HTTP door');
  assert.deepEqual(r.failed_sources, ['b']);
  assert.deepEqual(closed.sort(), ['http', 'ladder:a', 'ladder:b'], 'every ladder and the http client closed, failed source included');
  const s = ctx.config().settings.scan;
  for (const o of ladderOpts) assert.deepEqual([o.listingTtlHours, o.detailTtlHours], [s.listing_cache_hours, s.detail_cache_hours]);
  assert.deepEqual(delays, [1000], 'the source delay_ms paces its requests');
  assert.ok(fs.readdirSync(ctx.paths.cacheDir, { recursive: true }).length > 0, 'the page cache wrote under user/cache');
});

test('jobs scan with no injected factories uses the real HTTP client and ladder', async () => {
  const { fetch, calls } = stubFetch({ 'https://a.example/list': '<html><body>ok</body></html>' });
  const ctx = makeCtx({ now: NOW, configDir: configDir(), fetch });
  const r = await runScan(ctx, { sources: ['a'] }, {
    log: () => {},
    loadAdapter: adapters({
      a: async (c) => {
        const page = await c.ladder.page('https://a.example/list', { kind: 'listing' });
        return { jobs: page.ok ? [sj('a', '1')] : [], listed: 1, skippedSeen: 0, deferred: [] };
      },
    }),
  });
  assert.deepEqual(calls, ['https://a.example/list']);
  assert.equal(r.sources[0].inserted, 1);
  assert.equal(r.sources[0].tier, 'T1');
});

// ---------------------------------------------------------------- recheck --top ↔ top_reports

test('jobs recheck --top rechecks the jobs on the latest page of today\'s top report, in report order', async () => {
  const ctx = matchCtx();
  const ids = seedMany(ctx, 45);
  await run(scoreSave, { scores: ids.map((id, i) => item(id, 40 + (i % 50))) }, ctx);
  const first = await run(topCmd, { limit: 20 }, ctx);
  const shown1 = first.rows.map((r: any) => r.job_id);
  assert.equal(shown1.length, 20);
  assert.deepEqual(latestTopJobIds(ctx), shown1);
  const rc = (await execute(jobsRecheck, { top: true }, ctx)) as any;
  assert.ok(rc.ok, JSON.stringify(rc.error));
  assert.deepEqual(rc.data.rows.map((r: any) => r.id), shown1, 'the 20 being shown, in order');
  assert.equal(rc.data.closed, 0, 'ambiguous (network down in the test) means alive');

  const second = await run(topCmd, { limit: 20, offset: 20 }, ctx);
  const shown2 = second.rows.map((r: any) => r.job_id);
  assert.deepEqual(latestTopJobIds(ctx), shown2, '"more jobs" moves recheck to the new page');
  assert.equal(new Set([...shown1, ...shown2]).size, 40);
});

test('jobs recheck --top with no report today for this CV is NOT_FOUND, not yesterday\'s list', async () => {
  const ctx = matchCtx();
  const ids = seedMany(ctx, 3);
  await run(scoreSave, { scores: ids.map((id) => item(id, 70)) }, ctx);
  await run(topCmd, { limit: 20 }, ctx);
  const tomorrow = matchCtx({ home: ctx.paths.userDir, now: new Date('2026-11-16T04:00:00Z') });
  assert.deepEqual(latestTopJobIds(tomorrow), []);
  const rc = (await execute(jobsRecheck, { top: true }, tomorrow)) as any;
  assert.equal(rc.error.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------- score save ↔ cv ats-check

test('cv ats-check keywords come from what score save stores: matched plus met/partial requirements', async () => {
  const ctx = matchCtx();
  const [id] = seedMany(ctx, 1);
  await run(scoreSave, {
    scores: [item(id, 72, {
      matched: ['SQL', 'Power BI dashboards'],
      requirements: [
        { text: 'SQL', jd_quote: '2+ years of SQL', status: 'met' },
        { text: 'Advanced Excel', jd_quote: 'Advanced Excel', status: 'partial' },
        { text: 'Statistics degree', jd_quote: 'Degree in Statistics, IT or a related field', status: 'missing' },
      ],
    })],
  }, ctx);
  assert.deepEqual(keywordsFromScore(ctx, id).sort(), ['Advanced Excel', 'Power BI dashboards', 'SQL']);
});

test('cv ats-check splits a requirement label into keyword terms and drops years and degrees', async () => {
  const ctx = matchCtx();
  const [id] = seedMany(ctx, 1);
  await run(scoreSave, {
    scores: [item(id, 80, {
      matched: ['SQL'],
      requirements: [
        { text: 'SQL and Power BI', jd_quote: '2+ years of SQL', status: 'met' },
        { text: '2+ years', jd_quote: '2+ years of SQL', status: 'met' },
        { text: 'Statistics degree', jd_quote: 'Degree in Statistics, IT or a related field', status: 'met' },
        { text: 'Excel, Python', jd_quote: 'Advanced Excel', status: 'partial' },
      ],
    })],
  }, ctx);
  assert.deepEqual(keywordsFromScore(ctx, id).sort(), ['Excel', 'Power BI', 'Python', 'SQL']);
});
