import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter, { probe } from '../src/sources/lever/index.ts';
import { PAGE_SIZE, listUrl, postingIsSriLanka, type LvPosting } from '../src/sources/lever/parse.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

const fx = (n: string) => JSON.parse(readFixture('lever', n)) as LvPosting[];

test('scan: country field and location text decide; descriptions and fields come from the API', async () => {
  const ctx = fixtureContext({
    source: 'lever',
    boards: { lever: [{ name: 'dijital-team-pty-ltd', company: 'Dijital Team' }, { name: 'freebalance.com', company: 'FreeBalance' }] },
    json: { [listUrl('dijital-team-pty-ltd')]: fx('dijital-postings.json'), [listUrl('freebalance.com')]: fx('freebalance-postings.json') },
  });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 3, 'Krakow and Johannesburg are out');
  assert.equal(r.jobs.length, 3);
  assert.deepEqual(r.deferred, []);
  const ai = r.jobs.find((j) => j.title === 'AI Developer (Python/ Django)')!;
  assert.equal(ai.external_id, 'dijital-team-pty-ltd:9edbdbec-4130-4ca7-b4e7-93151d9a4a79');
  assert.equal(ai.company, 'Dijital Team');
  assert.equal(ai.location, 'Colombo');
  assert.equal(ai.remote, true);
  assert.equal(ai.employment_type, 'Full Time');
  assert.equal(ai.category, 'IT');
  assert.equal(ai.apply_url, 'https://jobs.lever.co/dijital-team-pty-ltd/9edbdbec-4130-4ca7-b4e7-93151d9a4a79');
  assert.match(ai.posted_at!, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.jobs.find((j) => j.title === 'Assistant Accountant')!.remote, false, 'hybrid is not remote');
  const fb = r.jobs.find((j) => j.company === 'FreeBalance')!;
  assert.equal(fb.location, 'Colombo, Western Province, Sri Lanka');
  assert.ok(fb.description!.includes('<h3>Key Responsibilities</h3><ul>'), 'tagged lists are part of the body');
  assert.ok(fb.description!.includes('We thank all'), 'and so is `additional`');
});

test('location filter: a Sri Lankan city with another country is out', () => {
  assert.equal(postingIsSriLanka({ country: 'BR', categories: { location: 'Colombo' } }), false);
  assert.equal(postingIsSriLanka({ country: 'IN', categories: { location: 'Bengaluru', allLocations: ['Bengaluru', 'Colombo, Sri Lanka'] } }), true);
  assert.equal(postingIsSriLanka({ categories: { location: 'Kandy' } }), true);
});

test('pagination: a full page asks for the next one', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `id-${i}`, text: `Job ${i}`, country: 'PL', categories: { location: 'Krakow' } }));
  const ctx = fixtureContext({
    source: 'lever',
    boards: { lever: ['big'] },
    json: { [listUrl('big', 0)]: full, [listUrl('big', PAGE_SIZE)]: fx('dijital-postings.json') },
  });
  const r = await adapter.scan(ctx);
  assert.deepEqual(ctx.calls.http.map((c) => c.url), [listUrl('big', 0), listUrl('big', PAGE_SIZE)]);
  assert.equal(r.jobs.length, 2);
});

test('a failing board is skipped', async () => {
  const ctx = fixtureContext({ source: 'lever', boards: { lever: ['gone', 'dijital-team-pty-ltd'] }, json: { [listUrl('dijital-team-pty-ltd')]: fx('dijital-postings.json') } });
  assert.equal((await adapter.scan(ctx)).jobs.length, 2);
  await assert.rejects(adapter.scan(fixtureContext({ source: 'lever', boards: { lever: ['gone'] } })), /Every lever board failed/);
});

test('recheck by board membership', async () => {
  const id = 'dijital-team-pty-ltd:9edbdbec-4130-4ca7-b4e7-93151d9a4a79';
  const job = { source_url: 'https://jobs.lever.co/x', external_id: id };
  const ctx = fixtureContext({ json: { [listUrl('dijital-team-pty-ltd')]: fx('dijital-postings.json') } });
  assert.equal(await adapter.recheck(job, ctx), 'alive');
  assert.equal(await adapter.recheck({ ...job, external_id: 'dijital-team-pty-ltd:00000000-0000-0000-0000-000000000000' }, ctx), 'closed');
  assert.equal(await adapter.recheck(job, fixtureContext({})), 'closed', 'board 404');
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [listUrl('dijital-team-pty-ltd')]: [] } })), 'unknown');
});

test('probe', async () => {
  const p = await probe(fixtureContext({ json: { [listUrl('freebalance.com')]: fx('freebalance-postings.json') } }).http, 'freebalance.com');
  assert.deepEqual(p, { valid: true, total_postings: 3, sri_lanka_postings: 1, sample_titles: ['Senior Functional Analyst'], company: null });
});
