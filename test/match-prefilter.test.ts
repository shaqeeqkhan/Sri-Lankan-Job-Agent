import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchPrefilter, scoreSave } from '../src/commands/match.ts';
import { execute } from '../src/registry.ts';
import { configWith, DESC, item, matchCtx, PROFILE, run, seed as seedJobs } from './match-fixture.ts';

const PROFILE_NE = { ...PROFILE, location: { value: 'Nuwara Eliya', inferred: true }, districts_ok: { value: ['Nuwara Eliya'], inferred: true } };

function seedVaried(ctx: ReturnType<typeof matchCtx>) {
  return seedJobs(ctx, [
    { ref: 'a', source_url: 'https://xpress.jobs/jobs/a', title: 'Data Analyst', company: 'Dialog Axiata', location: 'Colombo 02', closing_date: '2026-11-22', description: DESC() },
    { ref: 'b', source_url: 'https://xpress.jobs/jobs/b', title: 'Senior BI Analyst', company: 'John Keells IT', location: 'Colombo', closing_date: '2026-11-30', description: DESC('- SSIS') },
    { ref: 'c', source_url: 'https://xpress.jobs/jobs/c', title: 'Driver', company: 'Ceylon Transport', location: 'Colombo', closing_date: '2026-11-30', description: 'Heavy vehicle licence required.' },
    { ref: 'd', source_url: 'https://xpress.jobs/jobs/d', title: 'Data Analyst', company: 'Closed Co', location: 'Colombo', closing_date: '2026-11-10', description: DESC() },
    { ref: 'e', source_url: 'https://xpress.jobs/jobs/e', title: 'Data Analyst', company: 'Kandy Labs', location: 'Kandy', closing_date: '2026-11-30', description: DESC() },
    { ref: 'f', source_url: 'https://xpress.jobs/jobs/f', title: 'Data Analyst', company: 'Negombo Fish', location: 'Negombo', closing_date: '2026-11-30', description: DESC() },
    { ref: 'g', source_url: 'https://xpress.jobs/jobs/g', title: 'Reporting Analyst', company: 'HNB', location: 'Colombo', closing_date: '2026-11-30', description: DESC() },
    { ref: 'h', source_url: 'https://xpress.jobs/jobs/h', title: 'Data Analyst', company: 'Remote Co', location: 'Remote', remote: true, closing_date: '2026-11-30', description: 'Remote role. 2+ years of SQL. Experience with Power BI dashboards.' },
    { ref: 'i', source_url: 'https://xpress.jobs/jobs/i', title: 'Data Analyst', company: 'Old Post', location: 'Colombo', closing_date: null, posted_at: '2026-09-01', description: DESC() },
  ]);
}

const companies = (d: any) => d.candidates.map((c: any) => c.company);

test('prefilter ranks open, eligible jobs; title, location and since gates; closed jobs never appear', async () => {
  const ctx = matchCtx();
  seedVaried(ctx);
  const d = await run(matchPrefilter, { explain: true }, ctx);
  assert.deepEqual(new Set(companies(d)), new Set(['Dialog Axiata', 'John Keells IT', 'Remote Co']));
  assert.equal(d.pool.open, 8, 'Closed Co (closing date passed) is not open');
  assert.equal(d.pool.eligible, 3);
  assert.equal(d.pool.remaining, 3);
  assert.equal(companies(d)[0], 'Dialog Axiata', 'full title and skill overlap, right level, ranks first');
  // A junior (2 years) is not shown "Senior" posts first: the senior post keeps its title match but its seniority fit is low.
  const senior = d.candidates.find((c: any) => c.company === 'John Keells IT');
  assert.equal(senior.prefilter.title, 1);
  assert.ok(senior.prefilter.seniority < 0.5, `seniority ${senior.prefilter.seniority}`);
  assert.equal(companies(d).at(-1), 'John Keells IT');
  for (const c of d.candidates) {
    assert.ok(c.requirements_excerpt.length <= 1500);
    assert.deepEqual(Object.keys(c.prefilter).sort(), ['eligible_by', 'location', 'recency', 'seniority', 'skills', 'title', 'total']);
    assert.equal(c.is_image_ad, false);
    assert.ok(c.id && 'closing_date' in c && 'location' in c);
  }

  // Widening: adjacent titles, nearby districts, longer since window.
  assert.ok(companies(await run(matchPrefilter, { titles: ['adjacent'] }, ctx)).includes('HNB'));
  const near = companies(await run(matchPrefilter, { district: 'nearby' }, ctx));
  assert.ok(near.includes('Negombo Fish') && !near.includes('Kandy Labs'));
  assert.ok(companies(await run(matchPrefilter, { district: 'any' }, ctx)).includes('Kandy Labs'));
  assert.ok(companies(await run(matchPrefilter, { since: '90d' }, ctx)).includes('Old Post'));
  assert.deepEqual(companies(await run(matchPrefilter, { district: 'Kandy' }, ctx)), ['Kandy Labs']);
  assert.deepEqual(companies(await run(matchPrefilter, { remote: true }, ctx)), ['Remote Co']);
  const custom = await run(matchPrefilter, { titles: ['Driver'], district: 'any' }, ctx);
  assert.deepEqual(companies(custom), ['Ceylon Transport']);
  const widened = await run(matchPrefilter, { titles: ['adjacent'], since: '30d', district: 'nearby', widened: ['slow_sources'] }, ctx);
  assert.deepEqual(widened.widened.sort(), ['adjacent', 'nearby_remote', 'since:30d', 'since:90d', 'slow_sources'], 'recorded for the day, cumulatively');
});

test('prefilter is deterministic, with a stable tie-break (closing date, then id)', async () => {
  const ctx = matchCtx();
  const ids = seedJobs(
    ctx,
    ['z', 'y', 'x', 'w'].map((r, i) => ({
      ref: r, source_url: `https://xpress.jobs/jobs/${r}`, title: 'Data Analyst', company: `Twin ${r}`, location: 'Colombo',
      closing_date: i < 2 ? '2026-11-20' : '2026-11-25', description: DESC(),
    })),
  );
  // Identical text gives identical sub-scores except BM25 ties; ordering must not depend on insertion.
  const a = await run(matchPrefilter, {}, ctx);
  const b = await run(matchPrefilter, {}, ctx);
  assert.deepEqual(a.candidates, b.candidates);
  const order = a.candidates.map((c: any) => c.id);
  const early = ids.slice(0, 2).sort();
  const late = ids.slice(2).sort();
  assert.deepEqual(order, [...early, ...late]);
});

test('cache: re-run with no new jobs returns zero candidates; changed job text re-queues it; new rubric re-queues all', async () => {
  const ctx = matchCtx();
  seedVaried(ctx);
  const first = await run(matchPrefilter, {}, ctx);
  assert.equal(first.candidates.length, 3);
  const saved = await run(scoreSave, { scores: first.candidates.map((c: any, i: number) => item(c.id, 60 + i)) }, ctx);
  assert.equal(saved.saved, 3);

  const again = await run(matchPrefilter, {}, ctx);
  assert.equal(again.candidates.length, 0, 'nothing to score: zero LLM calls');
  assert.equal(again.pool.already_scored, 3);
  assert.equal(again.pool.remaining, 0);
  assert.equal(again.next_offset, null);
  assert.equal((await run(matchPrefilter, { include_scored: true }, ctx)).candidates.length, 3);

  const target = first.candidates[1].id;
  ctx.db().prepare('UPDATE jobs SET description = description || ? WHERE id = ?').run('\n- Now also Tableau', target);
  const changed = await run(matchPrefilter, {}, ctx);
  assert.deepEqual(changed.candidates.map((c: any) => c.id), [target]);
  assert.equal(changed.candidates[0].rescore, true);

  const ctx2 = matchCtx({ home: ctx.paths.userDir, configDir: configWith({ rubric_version: 'v2' }) });
  const v2 = await run(matchPrefilter, {}, ctx2);
  assert.equal(v2.rubric_version, 'v2');
  assert.equal(v2.candidates.length, 3, 'a new rubric version re-queues every job');
});

test('offset windows count scored jobs, so --offset 60 is the next window', async () => {
  const ctx = matchCtx();
  seedJobs(
    ctx,
    Array.from({ length: 7 }, (_, i) => ({
      ref: `o${i}`, source_url: `https://xpress.jobs/jobs/o${i}`, title: 'Data Analyst', company: `Win ${i}`, location: 'Colombo', closing_date: `2026-11-2${i}`, description: DESC(),
    })),
  );
  const w0 = await run(matchPrefilter, { limit: 3, offset: 0 }, ctx);
  assert.equal(w0.candidates.length, 3);
  assert.equal(w0.next_offset, 3);
  await run(scoreSave, { scores: w0.candidates.map((c: any) => item(c.id, 70)) }, ctx);
  const w1 = await run(matchPrefilter, { limit: 3, offset: 3, explain: true }, ctx);
  assert.deepEqual(w1.candidates.map((c: any) => c.rank), [4, 5, 6]);
  assert.equal(w1.next_offset, 6);
  assert.equal((await run(matchPrefilter, { limit: 3, offset: 0 }, ctx)).candidates.length, 0);
  const bad = (await execute(matchPrefilter, { since: 'yesterday' }, ctx)) as any;
  assert.equal(bad.error.code, 'INVALID_INPUT');
});

test('jobs.district stores the display name ("Nuwara Eliya"); prefilter district matching agrees with it', async () => {
  const ctx = matchCtx({ profile: { ...PROFILE_NE } });
  seedJobs(ctx, [
    { ref: 'ne1', source_url: 'https://xpress.jobs/jobs/ne1', title: 'Data Analyst', company: 'Hill Tea', location: 'Hatton', closing_date: '2026-11-30', description: DESC() },
    { ref: 'ne2', source_url: 'https://xpress.jobs/jobs/ne2', title: 'Data Analyst', company: 'Colombo Co', location: 'Colombo 03', closing_date: '2026-11-30', description: DESC() },
  ]);
  const stored = ctx.db().prepare("SELECT district FROM jobs WHERE company = 'Hill Tea'").pluck().get();
  assert.equal(stored, 'Nuwara Eliya');
  // Home district from the profile ("Nuwara Eliya") matches the stored display name.
  assert.deepEqual(companies(await run(matchPrefilter, {}, ctx)), ['Hill Tea']);
  // Slug and display forms of an explicit district both work.
  assert.deepEqual(companies(await run(matchPrefilter, { district: 'nuwara-eliya' }, ctx)), ['Hill Tea']);
  assert.deepEqual(companies(await run(matchPrefilter, { district: 'Colombo' }, ctx)), ['Colombo Co']);
});

test('skills rescue: an unusual title with the CV\'s skills in the ad is eligible (eligible_by skills); another function is not', async () => {
  const ctx = matchCtx();
  seedJobs(ctx, [
    { ref: 'r1', source_url: 'https://xpress.jobs/jobs/r1', title: 'Insights Analyst', company: 'Unusual Title Co', location: 'Colombo', closing_date: '2026-11-30', description: DESC() },
    { ref: 'r2', source_url: 'https://xpress.jobs/jobs/r2', title: 'Sales Executive', company: 'Sales Co', location: 'Colombo', closing_date: '2026-11-30', description: DESC() },
    { ref: 'r3', source_url: 'https://xpress.jobs/jobs/r3', title: 'Insights Analyst', company: 'No Skills Co', location: 'Colombo', closing_date: '2026-11-30', description: 'Great team.' },
    { ref: 'r4', source_url: 'https://xpress.jobs/jobs/r4', title: 'Data Analyst', company: 'Title Co', location: 'Colombo', closing_date: '2026-11-30', description: DESC() },
  ]);
  const d = await run(matchPrefilter, { explain: true }, ctx);
  const by = new Map(d.candidates.map((c: any) => [c.company, c.prefilter.eligible_by]));
  assert.equal(by.get('Unusual Title Co'), 'skills');
  assert.equal(by.get('Title Co'), 'title');
  assert.ok(!by.has('Sales Co'), 'a sales title is another job, whatever the ad mentions');
  assert.ok(!by.has('No Skills Co'));
  assert.ok(d.candidates.findIndex((c: any) => c.company === 'Title Co') < d.candidates.findIndex((c: any) => c.company === 'Unusual Title Co'));
});

test('batches: prefilter hands out score_batch candidates per call, lean by default; --batch 0 is the whole window', async () => {
  const ctx = matchCtx();
  seedJobs(
    ctx,
    Array.from({ length: 23 }, (_, i) => ({
      ref: `b${i}`, source_url: `https://xpress.jobs/jobs/b${i}`, title: 'Data Analyst', company: `Batch ${i}`, location: 'Colombo', closing_date: '2026-12-01', description: DESC(`- Item ${i}`),
    })),
  );
  const all = await run(matchPrefilter, { batch: 0, explain: true }, ctx);
  assert.equal(all.candidates.length, 23);
  assert.equal(all.left_in_window, 0);

  const seen: string[] = [];
  const sizes: number[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const d = await run(matchPrefilter, {}, ctx);
    if (!d.candidates.length) break;
    sizes.push(d.candidates.length);
    assert.equal(d.left_in_window, 23 - seen.length - d.candidates.length);
    for (const c of d.candidates) {
      // Lean: nothing the scorer does not need.
      assert.deepEqual(Object.keys(c).sort(), ['closing_date', 'company', 'id', 'is_image_ad', 'location', 'remote', 'requirements_excerpt', 'title']);
    }
    seen.push(...d.candidates.map((c: any) => c.id));
    await run(scoreSave, { scores: d.candidates.map((c: any) => item(c.id, 70)) }, ctx);
  }
  assert.deepEqual(sizes, [10, 10, 3]);
  // Same jobs in the same (rank) order as the whole window at once.
  assert.deepEqual(seen, all.candidates.map((c: any) => c.id));
});
