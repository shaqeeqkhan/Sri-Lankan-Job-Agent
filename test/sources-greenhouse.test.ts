import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter, { probe } from '../src/sources/greenhouse/index.ts';
import { detailUrl, listUrl } from '../src/sources/greenhouse/parse.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

const fx = (n: string) => JSON.parse(readFixture('greenhouse', n));
const LIST = listUrl('infuse');

test('scan keeps Sri Lanka postings, fetches their detail, decodes the content HTML', async () => {
  const ctx = fixtureContext({
    source: 'greenhouse',
    boards: { greenhouse: [{ name: 'infuse', company: 'INFUSE' }] },
    json: { [LIST]: fx('infuse-list.json'), [detailUrl('infuse', '4740223005')]: fx('infuse-detail.json') },
  });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 2, 'the two Singapore postings are filtered out');
  assert.deepEqual(r.deferred, ['infuse:4740212005']);
  assert.equal(r.jobs.length, 1);
  const j = r.jobs[0];
  assert.equal(j.external_id, 'infuse:4740223005');
  assert.equal(j.title, 'Client Success Representative (Remote within APAC region, Contract)');
  assert.equal(j.company, 'INFUSE');
  assert.equal(j.location, 'Sri Lanka');
  assert.equal(j.country_code, 'LK');
  assert.equal(j.posted_at, '2026-10-02', 'first_published, not updated_at');
  assert.equal(j.apply_url, 'https://job-boards.greenhouse.io/infuse/jobs/4740223005');
  assert.match(j.description!, /^<div class="content-intro"><p><strong>OUR HIRING PROCESS/);
  assert.ok(!ctx.calls.http.some((c) => /4734143005/.test(c.url)), 'no detail fetch for non-Sri Lanka roles');
});

test('a 404 board is skipped; all boards failing is a source error', async () => {
  const ctx = fixtureContext({ source: 'greenhouse', boards: { greenhouse: ['nope', 'infuse'] }, json: { [LIST]: fx('infuse-list.json') } });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 2);
  assert.ok(ctx.logs.some((l) => /nope: not found on Greenhouse/.test(l)));
  await assert.rejects(adapter.scan(fixtureContext({ source: 'greenhouse', boards: { greenhouse: ['nope'] } })), /Every greenhouse board failed/);
});

test('recheck by board membership', async () => {
  const live = { source_url: 'https://job-boards.greenhouse.io/infuse/jobs/4740223005', external_id: 'infuse:4740223005' };
  const gone = { ...live, external_id: 'infuse:1' };
  const ctx = fixtureContext({ json: { [LIST]: fx('infuse-list.json') } });
  assert.equal(await adapter.recheck(live, ctx), 'alive');
  assert.equal(await adapter.recheck(gone, ctx), 'closed');
  assert.equal(await adapter.recheck(live, fixtureContext({})), 'closed', 'board 404 = company left Greenhouse');
  assert.equal(await adapter.recheck(live, fixtureContext({ json: { [LIST]: { jobs: [] } } })), 'unknown', 'empty is ambiguous');
  assert.equal(await adapter.recheck(live, fixtureContext({ json: { [LIST]: {} }, status: { [LIST]: 500 } })), 'unknown');
});

test('probe', async () => {
  const p = await probe(fixtureContext({ json: { [LIST]: fx('infuse-list.json') } }).http, 'infuse');
  assert.deepEqual({ ...p, sample_titles: p.sample_titles.length }, { valid: true, total_postings: 4, sri_lanka_postings: 2, sample_titles: 2, company: 'INFUSE' });
  assert.equal((await probe(fixtureContext({}).http, 'nope')).valid, false);
});
