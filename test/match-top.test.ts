import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { matchPrefilter, scoreSave, topCmd, topResolveCmd, topWhyCmd } from '../src/commands/match.ts';
import { execute } from '../src/registry.ts';
import { item, matchCtx, NOW, run, seedMany } from './match-fixture.ts';

async function scored(n: number, over: (i: number) => object = () => ({})) {
  const ctx = matchCtx();
  const ids = seedMany(ctx, n, over);
  // Points 30..(30+n-1), spread so stars and points vary; several share stars to exercise the tie-breaks.
  for (let i = 0; i < ids.length; i += 50) {
    await run(scoreSave, { scores: ids.slice(i, i + 50).map((id, k) => item(id, Math.min(100, 30 + ((i + k) % 71)))) }, ctx);
  }
  return { ctx, ids };
}

test('top returns exactly 20 when the pool is ≥ 20, ranked by stars, points, closing date', async () => {
  const { ctx } = await scored(70);
  const d = await run(topCmd, {}, ctx);
  assert.equal(d.rows.length, 20);
  assert.equal(d.short_by, 0);
  assert.deepEqual(d.rows.map((r: any) => r.n), Array.from({ length: 20 }, (_, i) => i + 1));
  for (let i = 1; i < d.rows.length; i++) {
    const [p, q] = [d.rows[i - 1], d.rows[i]];
    assert.ok(p.stars > q.stars || (p.stars === q.stars && p.points >= q.points), 'sorted');
  }
  assert.equal(d.rows[0].fit, '★★★★★');
  assert.match(d.rows[0].url, /^https:\/\/xpress\.jobs\/jobs\/\d+$/, 'every row links to its ad');
  const why = await run(topWhyCmd, { n: 1 }, ctx);
  assert.equal(why.url, d.rows[0].url);
  assert.equal(d.pool.open, 70);
  assert.equal(d.pool.scored, 70);
  assert.equal(d.next_step.step, 'already_scored');
  assert.match(d.next_step.command, /--offset 20/);
  assert.deepEqual(d.recurring_gaps[0], { gap: 'No cloud (AWS/Azure)', count: 20, jobs: Array.from({ length: 20 }, (_, i) => i + 1) });
  const stats = JSON.parse(fs.readFileSync(ctx.paths.statsFile, 'utf8'));
  assert.equal(stats.top_reports, 1);
});

test('three pages give 60 distinct jobs numbered #1–#60; numbering is fixed for the day; the report file grows', async () => {
  const { ctx } = await scored(70);
  const p1 = await run(topCmd, { summary: 'Strong on SQL and Power BI; no cloud in 20 of the top 20.' }, ctx);
  const p2 = await run(topCmd, { offset: 20 }, ctx);
  const p3 = await run(topCmd, { offset: 40 }, ctx);
  const rows = [...p1.rows, ...p2.rows, ...p3.rows];
  assert.deepEqual(rows.map((r: any) => r.n), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.equal(new Set(rows.map((r: any) => r.job_id)).size, 60);

  const again = await run(topCmd, {}, ctx);
  assert.deepEqual(again.rows.map((r: any) => r.job_id), p1.rows.map((r: any) => r.job_id), 'page 1 again: same numbers');
  assert.equal((await run(topResolveCmd, { n: '#34' }, ctx)).job_id, p2.rows[13].job_id);

  const file = fs.readFileSync(p3.report_file, 'utf8');
  assert.ok(p3.report_file.endsWith('/reports/2026-11-15-top20.md'));
  assert.match(file, /^## Your top 20 — 15 Nov 2026 \(scanned 70 open jobs from 1 site\)/);
  assert.match(file, /_Showing 60 of 70 scored, 70 open\._/);
  assert.match(file, /\*\*How your CV reads to this market:\*\* Strong on SQL/);
  assert.match(file, /\| # \| Fit \| Role \| Company \| Location \| Closes \| Apply via \| Link \| Why \|/);
  assert.match(file, /^## #21–#40$/m);
  assert.match(file, /^## #41–#60$/m);
  assert.match(file, /^\| 1 \| ★★★★★ \| Data Analyst \| Company \d+ \| Colombo 03 \| 1 Dec \| jobs\d+@example\.lk \| \[View ad\]\(https:\/\/xpress\.jobs\/jobs\/\d+\) \| SQL and Power BI named; cloud missing \|$/m);
  assert.match(file, /Say \*\*"CV for #2"\*\*/);
  assert.equal((file.match(/^\| \d+ \|/gm) ?? []).length, 60);

  // Pages 4 runs out of scored jobs: 10 left, then the agent is told to score deeper or widen.
  const p4 = await run(topCmd, { offset: 60 }, ctx);
  assert.equal(p4.rows.length, 10);
  assert.equal(p4.short_by, 10);
  assert.ok(['score_deeper', 'widen'].includes(p4.next_step.step));
});

test('closed jobs drop out of the report; their number stays retired and the page is refilled', async () => {
  const { ctx } = await scored(30);
  const p1 = await run(topCmd, {}, ctx);
  const gone = p1.rows[2];
  ctx.db().prepare('UPDATE jobs SET closed_at = ?, closed_reason = ? WHERE id = ?').run(NOW.toISOString(), 'recheck', gone.job_id);
  const past = p1.rows[5];
  ctx.db().prepare("UPDATE jobs SET closing_date = '2026-11-01' WHERE id = ?").run(past.job_id);
  const again = await run(topCmd, {}, ctx);
  assert.equal(again.rows.length, 20);
  assert.ok(!again.rows.some((r: any) => r.job_id === gone.job_id || r.job_id === past.job_id));
  assert.deepEqual(again.dropped.map((x: any) => x.n), [3, 6]);
  assert.deepEqual(again.rows.slice(-2).map((r: any) => r.n), [21, 22], 'refilled with new numbers at the end');
  assert.equal((await run(topResolveCmd, { n: 3 }, ctx)).open, false, '#3 still means the same job');
  assert.equal(again.pool.open, 28);
});

test('pool under 20: shows what exists, short_by, and next_step to score deeper', async () => {
  const ctx = matchCtx();
  const ids = seedMany(ctx, 12);
  const pf = await run(matchPrefilter, { limit: 5 }, ctx);
  await run(scoreSave, { scores: pf.candidates.map((c: any) => item(c.id, 75)) }, ctx);
  const d = await run(topCmd, {}, ctx);
  assert.equal(d.rows.length, 5);
  assert.equal(d.short_by, 15);
  assert.equal(d.next_step.step, 'score_deeper');
  assert.match(d.next_step.command, /match prefilter --offset 0 --limit 60/);
  await run(scoreSave, { scores: ids.map((id) => item(id, 60)) }, ctx);
  const full = await run(topCmd, { offset: 5 }, ctx);
  assert.equal(full.rows.length, 7);
  assert.equal(full.next_step.step, 'widen');
  assert.equal(full.next_step.widen, 'adjacent');
});

test('variants re-rank the remaining pool without re-scoring: district, remote, like', async () => {
  const { ctx, ids } = await scored(40, (i) => (i % 4 === 0 ? { location: 'Kandy' } : i % 4 === 1 ? { location: 'Remote', remote: true } : {}));
  await run(topCmd, {}, ctx);
  const kandy = await run(topCmd, { district: 'Kandy' }, ctx);
  assert.ok(kandy.rows.length > 0);
  assert.ok(kandy.rows.every((r: any) => r.location === 'Kandy'));
  assert.equal(kandy.rows[0].n, 21, 'numbering continues');
  assert.equal(kandy.variant, 'in Kandy');
  const remote = await run(topCmd, { remote: true }, ctx);
  assert.ok(remote.rows.every((r: any) => r.location === 'Remote'));
  const like = await run(topCmd, { like: '#1', limit: 3 }, ctx);
  assert.equal(like.rows.length, 3);
  const seen = new Set([...kandy.rows, ...remote.rows].map((r: any) => r.job_id));
  assert.ok(like.rows.every((r: any) => !seen.has(r.job_id)), 'only jobs not shown yet');
  const file = fs.readFileSync(like.report_file, 'utf8');
  assert.match(file, /^## #21–#\d+ \(in Kandy\)$/m);
  assert.match(file, /\(like #1\)$/m);
  assert.equal(ids.length, 40);
});

test('top why prints the rubric; top resolve maps #n to the job id; unknown numbers are NOT_FOUND', async () => {
  const { ctx } = await scored(25);
  const p1 = await run(topCmd, {}, ctx);
  const why = await run(topWhyCmd, { n: '#2' }, ctx);
  assert.equal(why.job_id, p1.rows[1].job_id);
  assert.deepEqual(why.dimensions.map((x: any) => [x.dimension, x.max]), [
    ['role_fit', 25], ['must_haves', 30], ['seniority', 15], ['education', 10], ['location', 10], ['domain', 10],
  ]);
  assert.equal(why.dimensions.reduce((s: number, x: any) => s + x.points, 0), why.points);
  assert.equal(why.requirements[0].status, 'met');
  assert.equal(why.capped_by, null);
  const text = topWhyCmd.format!(why);
  assert.match(text, /\| Must-have requirements \| \d+ \/ 30 \|/);
  assert.match(text, /\| SQL \| "2\+ years of SQL" \| met \|/);
  assert.match(text, /No caps applied/);

  assert.equal((await run(topResolveCmd, { n: 1 }, ctx)).job_id, p1.rows[0].job_id);
  assert.equal(((await execute(topResolveCmd, { n: '#99' }, ctx)) as any).error.code, 'NOT_FOUND');
  assert.equal(((await execute(topResolveCmd, { n: 'abc' }, ctx)) as any).error.code, 'INVALID_INPUT');
  const fresh = matchCtx();
  assert.equal(((await execute(topWhyCmd, { n: 1 }, fresh)) as any).error.code, 'NOT_FOUND');
});

test('scam and mandatory caps show in the report', async () => {
  const ctx = matchCtx();
  const [a, b] = seedMany(ctx, 2);
  await run(scoreSave, { scores: [item(a, 95, { scam_signals: ['registration fee'] }), item(b, 90, { missing_mandatory: ['AAT'] })] }, ctx);
  const d = await run(topCmd, {}, ctx);
  assert.deepEqual(d.rows.map((r: any) => [r.job_id, r.fit]), [[b, '★★☆☆☆'], [a, '⚠️ ★☆☆☆☆']]);
  const why = await run(topWhyCmd, { n: 2 }, ctx);
  assert.match(topWhyCmd.format!(why), /Capped at 1 star: scam signal \(registration fee\) \(points alone give 5 stars\)/);
});

test('top --brief returns the page as Markdown instead of rows; later pages get their own heading; scam rows are named', async () => {
  const small = await scored(20);
  await run(scoreSave, { scores: [item(small.ids[0], 95, { scam_signals: ['asks for a registration fee'] })] }, small.ctx);
  const full = await run(topCmd, {}, small.ctx);
  const flagged = await run(topCmd, { brief: true }, small.ctx);
  assert.deepEqual(flagged.scam_rows, full.rows.filter((r: any) => r.scam).map((r: any) => r.n));
  assert.equal(flagged.scam_rows.length, 1);

  const { ctx } = await scored(45);
  const brief = await run(topCmd, { brief: true, summary: 'Strong on SQL.' }, ctx);
  assert.equal(brief.rows, undefined);
  assert.equal(brief.shown, 20);
  assert.deepEqual(brief.scam_rows, []);
  assert.match(brief.next_step.command, /top --offset 20 .*--brief/, 'the follow-up stays lean');
  // Page 1 is the report file, line for line.
  assert.equal(brief.page_markdown.trim(), fs.readFileSync(brief.report_file, 'utf8').trim());
  assert.match(brief.page_markdown, /How your CV reads to this market:\*\* Strong on SQL\./);

  const p2 = await run(topCmd, { offset: 20, brief: true }, ctx);
  assert.match(p2.page_markdown, /^## #21–#40\n/);
  assert.equal(p2.page_markdown.split('\n').filter((l: string) => /^\| \d+ \|/.test(l)).length, 20);
  assert.doesNotMatch(p2.page_markdown, /^\| 1 \|/m);
});
