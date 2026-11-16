import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter, { probe } from '../src/sources/smartrecruiters/index.ts';
import { PAGE_SIZE, detailUrl, postingIsSriLanka, searchUrl } from '../src/sources/smartrecruiters/parse.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

const fx = (n: string) => JSON.parse(readFixture('smartrecruiters', n));
const IFS = searchUrl('IFS1', 0);

test('scan: country=lk listing, detail per posting, role sections only', async () => {
  const ctx = fixtureContext({
    source: 'smartrecruiters',
    boards: { smartrecruiters: [{ name: 'IFS1', company: 'IFS' }] },
    json: { [IFS]: fx('ifs-lk.json'), [detailUrl('IFS1', '744000161224229')]: fx('ifs-detail.json') },
  });
  const r = await adapter.scan(ctx);
  assert.equal(ctx.calls.http[0].url, 'https://api.smartrecruiters.com/v1/companies/IFS1/postings?country=lk&limit=100&offset=0');
  assert.equal(r.listed, 2);
  assert.deepEqual(r.deferred, ['IFS1:744000161213329']);
  const j = r.jobs[0];
  assert.equal(j.external_id, 'IFS1:744000161224229');
  assert.equal(j.company, 'IFS');
  assert.equal(j.location, 'Colombo, Western Province, Sri Lanka');
  assert.equal(j.remote, false);
  assert.equal(j.employment_type, 'Full-time');
  assert.equal(j.source_url, 'https://jobs.smartrecruiters.com/IFS1/744000161224229');
  assert.match(j.apply_url!, /^https:\/\/jobs\.smartrecruiters\.com\/IFS1\/744000161224229-/);
  assert.ok(j.description!.includes('<h3>Qualifications</h3>'));
  assert.ok(!j.description!.includes(fx('ifs-detail.json').jobAd.sections.companyDescription.text.slice(0, 60)), 'company boilerplate left out');
});

test('location guard drops a posting the country filter let through', () => {
  for (const p of fx('navitas-lk.json').content) assert.ok(postingIsSriLanka(p), p.name);
  assert.equal(postingIsSriLanka({ location: { city: 'bangalore', country: 'in', fullLocation: 'bangalore, , India' } }), false);
});

test('pagination and board failure isolation', async () => {
  const full = { totalFound: PAGE_SIZE + 3, content: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: String(i), name: `J${i}`, location: { country: 'in', city: 'Pune' } })) };
  const ctx = fixtureContext({
    source: 'smartrecruiters',
    boards: { smartrecruiters: ['Broken', 'Navitas'] },
    json: { [searchUrl('Navitas', 0)]: full, [searchUrl('Navitas', PAGE_SIZE)]: fx('navitas-lk.json') },
    status: { [searchUrl('Broken', 0)]: 500 },
  });
  const r = await adapter.scan(ctx);
  assert.ok(ctx.calls.http.some((c) => c.url === searchUrl('Navitas', PAGE_SIZE)));
  assert.equal(r.listed, 3, 'only the Sri Lanka postings of page two survive the guard');
  assert.ok(ctx.logs.some((l) => /Broken: postings: HTTP/.test(l)));
});

test('recheck uses the posting\'s own active flag', async () => {
  const job = { source_url: 'x', external_id: 'IFS1:744000161224229' };
  const url = detailUrl('IFS1', '744000161224229');
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [url]: fx('ifs-detail.json') } })), 'alive');
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [url]: { ...fx('ifs-detail.json'), active: false } } })), 'closed');
  assert.equal(await adapter.recheck(job, fixtureContext({})), 'closed', '404');
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [url]: {} }, status: { [url]: 503 } })), 'unknown');
});

test('probe: a wrong company id answers totalFound 0', async () => {
  const all = searchUrl('Navitas', 0, 1, null);
  const ok = await probe(fixtureContext({ json: { [all]: { totalFound: 44, content: [{ company: { name: 'Navitas' } }] }, [searchUrl('Navitas', 0)]: fx('navitas-lk.json') } }).http, 'Navitas');
  assert.deepEqual({ ...ok, sample_titles: ok.sample_titles.length }, { valid: true, total_postings: 44, sri_lanka_postings: 3, sample_titles: 3, company: 'Navitas' });
  const bad = await probe(fixtureContext({ json: { [searchUrl('visa', 0, 1, null)]: { totalFound: 0, content: [] } } }).http, 'visa');
  assert.equal(bad.valid, false);
});
