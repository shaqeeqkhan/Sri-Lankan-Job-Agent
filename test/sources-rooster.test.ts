import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/rooster/index.ts';
import { SEARCH_URL, externalIdFromUrl, isSriLanka, itemToJob, pageActive, parseSearch, salaryText } from '../src/sources/rooster/parse.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

const SEARCH = JSON.parse(readFixture('rooster', 'search-page1.json'));
const DOPEN = readFixture('rooster', 'detail-520121.html');
const DCLOSED = readFixture('rooster', 'detail-closed-518500.html');
const NOW = new Date('2026-11-15T04:00:00Z');

test('rooster: external id from job URLs', () => {
  assert.equal(externalIdFromUrl('https://rooster.jobs/jobs/520121'), '520121');
  assert.equal(externalIdFromUrl('https://rooster.jobs/job/520121?ref=share'), '520121');
  assert.equal(externalIdFromUrl('https://rooster.jobs/156578'), null);
});

test('rooster: search answer parses; non–Sri Lanka roles are recognised', () => {
  const p = parseSearch(JSON.stringify(SEARCH));
  assert.ok(p);
  assert.equal(p.items.length, 5);
  assert.deepEqual(p.items.filter(isSriLanka).map((i) => i.id), [520056, 519831, 520064, 519979]);
  assert.equal(parseSearch('{"status":200,"body":{}}'), null);
  assert.equal(parseSearch('<html>'), null);
});

test('rooster: item → job', () => {
  const item = SEARCH.body.data.find((x: { id: number }) => x.id === 520056);
  const job = itemToJob(item, NOW);
  assert.ok(job);
  assert.equal(job.title, 'Sales Executive');
  assert.equal(job.location, 'Colombo, Sri Lanka');
  assert.equal(job.salary_text, 'LKR 90,000–150,000 / month');
  assert.equal(job.posted_at, '2026-11-04');
  assert.equal(job.closing_date, null, 'Rooster has no closing date');
  assert.equal(job.apply_method, 'portal');
  assert.equal(job.apply_url, 'https://rooster.jobs/jobs/520056');
  assert.equal(job.source_url, 'https://rooster.jobs/jobs/520056');
  assert.equal(job.external_id, '520056');
  assert.equal(job.country_code, 'LK');
  assert.equal(job.remote, false);
  assert.equal(job.scraped_at, NOW.toISOString());
  const remote = itemToJob(SEARCH.body.data.find((x: { id: number }) => x.id === 519831), NOW);
  assert.equal(remote?.remote, true);
  assert.equal(remote?.company, 'Nextjob');
  assert.equal(remote?.employment_type, 'full-time');
  assert.equal(salaryText({ id: 1, min_salary: 5000, max_salary: 5000, salary_currency: 'SAR', salary_frequency: 'month' }), 'SAR 5,000 / month');
  assert.equal(salaryText({ id: 1, min_salary: 5000, max_salary: null, salary_currency: null }), null, 'no currency, no salary');
});

test('rooster: scan pages the API with the Sri Lanka filter, drops others, skips seen, newest first', async () => {
  const bodies: unknown[] = [];
  const ctx = fixtureContext({
    source: 'rooster',
    json: { [SEARCH_URL]: (_u: string, body?: unknown) => (bodies.push(body), SEARCH) },
    seen: ['520064'],
  });
  const r = await adapter.scan(ctx);
  assert.deepEqual(bodies, [{ query: [], limit: 50, page: 1, filters: { country: 'Sri Lanka' } }], 'count 5 < 50: one page');
  assert.equal(r.listed, 4);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['520056', '519979', '519831']);
  assert.deepEqual(r.deferred, [], 'the listing carries the whole posting: nothing to defer');
  assert.equal(ctx.calls.pages.length, 0);
});

test('rooster: a failed later page keeps what was read; a failed or drifted first page is a whole-source failure', async () => {
  let n = 0;
  const ctx = fixtureContext({
    source: { id: 'rooster', options: { page_size: 2 } },
    json: { [SEARCH_URL]: () => (++n === 1 ? { ...SEARCH, body: { ...SEARCH.body, count: 10, data: SEARCH.body.data.slice(0, 2) } } : '<html>502</html>') },
  });
  const r = await adapter.scan(ctx);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['520056']);
  assert.match(ctx.logs.join('\n'), /search page 2 gave an unexpected answer/);
  await assert.rejects(adapter.scan(fixtureContext({ source: 'rooster' })), /HTTP 404/);
  await assert.rejects(adapter.scan(fixtureContext({ source: 'rooster', json: { [SEARCH_URL]: { status: 200, body: { results: [] } } } })), /drift/);
});

test('rooster: max_details caps new jobs', async () => {
  const ctx = fixtureContext({ source: { id: 'rooster', max_details: 2 }, json: { [SEARCH_URL]: SEARCH } });
  assert.equal((await adapter.scan(ctx)).jobs.length, 2);
});

test('rooster: recheck reads job.active from the job page', async () => {
  assert.equal(pageActive(DOPEN), true);
  assert.equal(pageActive(DCLOSED), false);
  const ctx = fixtureContext({
    source: 'rooster',
    pages: {
      'https://rooster.jobs/jobs/520121': DOPEN,
      'https://rooster.jobs/jobs/518500': DCLOSED,
      'https://rooster.jobs/jobs/1': '<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}},"page":"/404-page"}</script></html>',
    },
  });
  const check = (id: string) => adapter.recheck({ source_url: `https://rooster.jobs/jobs/${id}`, external_id: id }, ctx);
  assert.equal(await check('520121'), 'alive');
  assert.equal(await check('518500'), 'closed');
  assert.equal(await check('1'), 'unknown', '/404-page is a soft 404');
  assert.equal(await check('2'), 'unknown', 'fetch failed');
});
