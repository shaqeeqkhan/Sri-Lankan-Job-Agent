import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter, { probe } from '../src/sources/ashby/index.ts';
import { jobIsSriLanka, listUrl, type AbJob } from '../src/sources/ashby/parse.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

// A real Ashby response (Hatch, 15 Nov 2026), trimmed. No Ashby board with Sri Lanka roles was
// found live, so the "in" posting is the second real posting with its location edited to Colombo.
function board(): { jobs: AbJob[] } {
  const b = JSON.parse(readFixture('ashby', 'hatch-board.json'));
  b.jobs[1].location = 'Colombo';
  b.jobs[1].address = { postalAddress: { addressLocality: 'Colombo', addressCountry: 'Sri Lanka' } };
  b.jobs[1].workplaceType = 'Hybrid';
  b.jobs[1].isRemote = true;
  b.jobs[1].compensation = { compensationTierSummary: 'LKR 400K – 600K' };
  return b;
}

test('scan keeps the Sri Lanka posting and maps the structured fields', async () => {
  const ctx = fixtureContext({ source: 'ashby', boards: { ashby: [{ name: 'Hatch', company: 'Hatch' }] }, json: { [listUrl('Hatch')]: board() } });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 1, 'the United States posting is out');
  const j = r.jobs[0];
  assert.equal(j.external_id, 'Hatch:4b52aba4-7d4c-4674-a59b-a52f169a496a');
  assert.equal(j.title, 'Sales Engineer');
  assert.equal(j.location, 'Colombo');
  assert.equal(j.remote, false, 'workplaceType Hybrid wins over isRemote');
  assert.equal(j.salary_text, 'LKR 400K – 600K');
  assert.equal(j.employment_type, 'Full time');
  assert.equal(j.country_code, 'LK');
  assert.match(j.apply_url!, /^https:\/\/jobs\.ashbyhq\.com\/Hatch\//);
  assert.ok(j.description);
});

test('filter: secondary locations, unlisted postings', () => {
  const us: AbJob = { location: 'New York', address: { postalAddress: { addressCountry: 'United States' } } };
  assert.equal(jobIsSriLanka(us), false);
  assert.equal(jobIsSriLanka({ ...us, secondaryLocations: [{ location: 'Colombo', address: { postalAddress: { addressCountry: 'Sri Lanka' } } }] }), true);
  assert.equal(jobIsSriLanka({ location: 'Colombo, Sri Lanka', isListed: false }), false);
});

test('failing board skipped; all failing is an error', async () => {
  const ctx = fixtureContext({ source: 'ashby', boards: { ashby: ['gone', 'Hatch'] }, json: { [listUrl('Hatch')]: board() } });
  assert.equal((await adapter.scan(ctx)).jobs.length, 1);
  await assert.rejects(adapter.scan(fixtureContext({ source: 'ashby', boards: { ashby: ['gone'] } })), /Every ashby board failed/);
});

test('recheck by board membership', async () => {
  const job = { source_url: 'x', external_id: 'Hatch:4b52aba4-7d4c-4674-a59b-a52f169a496a' };
  const ctx = fixtureContext({ json: { [listUrl('Hatch')]: board() } });
  assert.equal(await adapter.recheck(job, ctx), 'alive');
  assert.equal(await adapter.recheck({ ...job, external_id: 'Hatch:nope' }, ctx), 'closed');
  const unlisted = board();
  unlisted.jobs[1].isListed = false;
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [listUrl('Hatch')]: unlisted } })), 'closed');
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [listUrl('Hatch')]: { jobs: [] } } })), 'unknown');
});

test('probe', async () => {
  const p = await probe(fixtureContext({ json: { [listUrl('Hatch')]: board() } }).http, 'Hatch');
  assert.deepEqual(p, { valid: true, total_postings: 2, sri_lanka_postings: 1, sample_titles: ['Sales Engineer'], company: null });
});
