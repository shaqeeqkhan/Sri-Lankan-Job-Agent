import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colomboToday, jobsGet, jobsList } from '../src/commands/jobs.ts';
import { execute } from '../src/registry.ts';
import { makeCtx, seedJobs } from './helpers.ts';

async function seeded() {
  const jobs = [
    { ref: 'a', external_id: 'a', title: 'Assistant Accountant', closing_date: '2026-11-04', location: 'Colombo 03' },
    { ref: 'b', external_id: 'b', source: 'rooster', title: 'Software Engineer', company: 'Kandy Code Labs', source_url: 'https://rooster.jobs/b', platform: 'rooster', apply_method: 'portal' as const, apply_email: null, apply_url: 'https://rooster.jobs/apply/b', closing_date: '2026-10-25', location: 'Kandy' },
    { ref: 'c', external_id: 'c', title: 'Staff Nurse', company: 'Hill Country Hospitals', source_url: null, closing_date: '2026-10-10' },
    { ref: 'd', external_id: 'd', title: 'Driver', company: 'Ceylon Transport', source_url: null, closing_date: null, location: 'Galle', apply_method: 'phone' as const, apply_email: null, apply_phone: '0771234567' },
  ];
  const ctx = makeCtx();
  seedJobs(ctx, jobs);
  return ctx;
}

const titles = (res: any) => res.data.jobs.map((j: any) => j.title);

test('closed jobs are hidden by default; soonest closing first, undated last', async () => {
  const ctx = await seeded();
  const res = (await execute(jobsList, {}, ctx)) as any;
  assert.equal(res.data.today, '2026-10-21');
  assert.deepEqual(titles(res), ['Software Engineer', 'Assistant Accountant', 'Driver']);
  assert.equal(res.data.jobs[0].description, undefined, 'list omits descriptions');
  const all = (await execute(jobsList, { include_closed: true }, ctx)) as any;
  assert.equal(all.data.total, 4);
});

test('filters', async () => {
  const ctx = await seeded();
  const t = async (input: object) => titles(await execute(jobsList, input, ctx));
  assert.deepEqual(await t({ q: 'engineer' }), ['Software Engineer']);
  assert.deepEqual(await t({ platform: 'rooster' }), ['Software Engineer']);
  assert.deepEqual(await t({ apply_method: 'phone' }), ['Driver']);
  assert.deepEqual(await t({ location: 'colombo' }), ['Assistant Accountant']);
  assert.deepEqual(await t({ closing_within_days: 7 }), ['Software Engineer']);
  assert.deepEqual(await t({ q: '100%_' }), [], 'LIKE wildcards are escaped');
  const page = (await execute(jobsList, { limit: 1, offset: 1 }, ctx)) as any;
  assert.equal(page.data.total, 3);
  assert.deepEqual(titles(page), ['Assistant Accountant']);
});

test('get returns the full job with sources; unknown id is NOT_FOUND', async () => {
  const ctx = await seeded();
  const [first] = ((await execute(jobsList, {}, ctx)) as any).data.jobs;
  const res = (await execute(jobsGet, { id: first.id }, ctx)) as any;
  assert.equal(res.data.title, 'Software Engineer');
  assert.ok('description' in res.data);
  assert.equal(res.data.sources.length, 1);
  assert.equal(res.data.score, null);
  assert.equal(res.data.external_id, 'b');
  assert.equal('identity_t2' in res.data, false, 'internal identity keys are not returned');
  const missing = (await execute(jobsGet, { id: 'jnope' }, ctx)) as any;
  assert.equal(missing.error.code, 'NOT_FOUND');
});

test('"today" is the date in Colombo, not UTC', () => {
  // 20:00 UTC on the 21st is 01:30 on the 22nd in Sri Lanka.
  assert.equal(colomboToday(new Date('2026-10-21T20:00:00Z')), '2026-10-22');
});
