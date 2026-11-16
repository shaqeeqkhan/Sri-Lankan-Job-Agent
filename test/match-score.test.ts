import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { matchEval, scoreGet, scoreList, scoreSave } from '../src/commands/match.ts';
import { execute } from '../src/registry.ts';
import { item, matchCtx, run, seedMany } from './match-fixture.ts';

test('score save: code derives points, stars and caps; per-item errors; the valid rest is saved', async () => {
  const ctx = matchCtx();
  const [a, b, c, d, e, f] = seedMany(ctx, 6);
  const res = (await execute(
    scoreSave,
    {
      scores: [
        item(a, 88),
        item(b, 90, { missing_mandatory: ['CIMA passed finalist'] }),
        item(c, 95, { scam_signals: ['asks for a Rs. 2,500 registration fee'] }),
        item(d, 70, { requirements: [{ text: 'Cloud', jd_quote: '3 years of AWS', status: 'missing' }] }),
        item(e, 70, { dimensions: { role_fit: 26, must_haves: 30, seniority: 0, education: 0, location: 0, domain: 0 } }),
        item(f, 70, { why: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone' }),
        item('jnope', 70),
        { job_id: a },
      ],
    },
    ctx,
  )) as any;
  assert.equal(res.ok, true);
  const data = res.data;
  assert.equal(data.saved, 3);
  assert.deepEqual(
    data.results.map((r: any) => [r.job_id, r.points, r.stars, r.capped_by]),
    [[a, 88, 5, null], [b, 90, 2, 'missing_mandatory'], [c, 95, 1, 'scam']],
  );
  const problems = Object.fromEntries(data.errors.map((x: any) => [x.index, x.problems.join(' ')]));
  assert.match(problems[3], /jd_quote.*not in the job ad/);
  assert.match(problems[4], /dimensions\.role_fit: at most 25/);
  assert.match(problems[5], /20 words or fewer/);
  assert.match(problems[6], /no job with id jnope/);
  assert.match(problems[7], /dimensions/);
  assert.equal(data.errors.length, 5);

  // Upsert on (job, resume, rubric): saving again replaces, never duplicates.
  await run(scoreSave, { scores: [item(a, 50)] }, ctx);
  const list = await run(scoreList, {}, ctx);
  assert.equal(list.total, 3);
  const got = await run(scoreGet, { job_id: a }, ctx);
  assert.equal(got.points, 50);
  assert.equal(got.stars, 2);
  assert.equal(got.requirements[0].jd_quote, '2+ years of SQL');
  assert.ok(got.job_hash);
});

test('match eval compares saved stars with human labels (±1) and lists the misses', async () => {
  const ctx = matchCtx();
  const ids = seedMany(ctx, 4);
  await run(scoreSave, { scores: [item(ids[0], 90), item(ids[1], 60), item(ids[2], 20)] }, ctx);
  const file = path.join(ctx.paths.userDir, 'labels.csv');
  fs.writeFileSync(file, `# recruiter labels\njob_id,human_stars\n${ids[0]},4\n${ids[1]},3\n${ids[2]},4\n${ids[3]},2\n`);
  const res = (await execute(matchEval, { labels: file }, ctx)) as any;
  assert.equal(res.ok, true);
  const d = res.data;
  assert.equal(d.compared, 3);
  assert.equal(d.within_1, 2);
  assert.deepEqual(d.unscored, [ids[3]]);
  assert.deepEqual(d.misses.map((m: any) => [m.job_id, m.human, m.agent]), [[ids[2], 4, 1]]);
  assert.equal(d.pass, false, 'fewer than 30 labels never passes');
  const json = path.join(ctx.paths.userDir, 'labels.json');
  fs.writeFileSync(json, JSON.stringify([{ job_id: ids[0], human_stars: 5 }]));
  assert.equal(((await execute(matchEval, { labels: json }, ctx)) as any).data.within_1_share, 1);
  fs.writeFileSync(file, 'job_id,human_stars\nx,9\n');
  assert.equal(((await execute(matchEval, { labels: file }, ctx)) as any).error.code, 'INVALID_INPUT');
});
