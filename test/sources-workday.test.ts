import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter, { probe } from '../src/sources/workday/index.ts';
import { detailUrl, postedOnDate, postingId, sriLankaFacet } from '../src/sources/workday/parse.ts';
import type { WorkdayBoard } from '../src/sources/ats-common.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

const fx = (n: string) => JSON.parse(readFixture('workday', n));
const LSEG: WorkdayBoard = { family: 'workday', name: 'lseg|wd3|Careers', company: 'LSEG', tenant: 'lseg', wd: 'wd3', site: 'Careers' };
const SEARCH = 'https://lseg.wd3.myworkdayjobs.com/wday/cxs/lseg/Careers/jobs';
const LK = 'db69e062446c11de98360015c5e6daf6';
const KYC = '/job/Colombo-Sri-Lanka/Intern--KYC-Operations_R0124513';
const FIN = '/job/Colombo-Sri-Lanka/Intern--Finance-Operations_R0125112';

/** The CxS search answers by body: no facets → the whole board; the Sri Lanka facet → its pages. */
function searchRoute(_url: string, body: any) {
  const facets = body?.appliedFacets ?? {};
  if (!facets.locationCountry) return fx('lseg-search-all.json');
  assert.deepEqual(facets.locationCountry, [LK]);
  return body.offset === 0 ? fx('lseg-search-lk-0.json') : fx('lseg-search-lk-1.json');
}

function ctxFor(over: Parameters<typeof fixtureContext>[0] = {}) {
  return fixtureContext({
    source: 'workday',
    boards: { workday: [{ name: 'lseg|wd3|Careers', company: 'LSEG' }] },
    json: {
      [SEARCH]: searchRoute,
      [detailUrl(LSEG, KYC)]: fx('lseg-detail-kyc.json'),
      [detailUrl(LSEG, FIN)]: fx('lseg-detail-finance.json'),
    },
    ...over,
  });
}

test('finds the Sri Lanka country facet', () => {
  assert.deepEqual(sriLankaFacet(fx('lseg-search-all.json')), { param: 'locationCountry', ids: [LK], count: 31 });
  assert.equal(sriLankaFacet({ facets: [{ facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locationCountry', values: [{ descriptor: 'India', id: 'x', count: 3 }] }] }] }), null);
  assert.equal(sriLankaFacet({ facets: [] }), 'none');
  // No country facet: city values naming Sri Lankan places are used instead (Sysco LABS' tenant).
  assert.deepEqual(
    sriLankaFacet({ facets: [{ facetParameter: 'locations', values: [{ descriptor: 'Sysco LABS - - - Sri Lanka', id: 'a', count: 46 }, { descriptor: 'Houston', id: 'b', count: 9 }] }] }),
    { param: 'locations', ids: ['a'], count: 46 },
  );
});

test('scan pages the Sri Lanka facet, fetches details, defers failed ones', async () => {
  const ctx = ctxFor();
  const r = await adapter.scan(ctx);
  const searches = ctx.calls.http.filter((c) => c.method === 'POST');
  assert.deepEqual(searches.map((c: any) => [c.body.offset, Object.keys(c.body.appliedFacets)]), [[0, []], [0, ['locationCountry']], [20, ['locationCountry']]]);
  assert.equal(r.listed, 23, '20 on page one + 3 on the trimmed page two');
  assert.equal(r.jobs.length, 2);
  assert.equal(r.deferred.length, 21, 'details with no fixture are deferred, never stored thin');
  const kyc = r.jobs.find((j) => j.title === 'Intern, KYC Operations')!;
  assert.equal(kyc.external_id, 'lseg/Careers:R0124513');
  assert.equal(kyc.company, 'LSEG');
  assert.equal(kyc.location, 'Colombo, Sri Lanka');
  assert.equal(kyc.country_code, 'LK');
  assert.equal(kyc.posted_at, '2026-11-12');
  assert.equal(kyc.closing_date, '2026-11-22');
  assert.equal(kyc.employment_type, 'Full time');
  assert.equal(kyc.source_url, 'https://lseg.wd3.myworkdayjobs.com/Careers/job/Colombo-Sri-Lanka/Intern--KYC-Operations_R0124513');
  assert.match(kyc.description!, /^<p>This role is within our Corporate Operations team/);
  // "2 Locations" on the listing → the detail's real offices.
  const fin = r.jobs.find((j) => j.external_id === 'lseg/Careers:R0125112')!;
  assert.equal(fin.location, 'Colombo, Sri Lanka; IND-Bangalore-TowerE,RMZ Infin');
  assert.equal(fin.country_code, 'LK');
});

test('seen postings skip their detail fetch; max_details caps newest first', async () => {
  const ctx = ctxFor({ seen: ['lseg/Careers:R0124513'], source: { id: 'workday', max_details: 1 } });
  const r = await adapter.scan(ctx);
  assert.equal(r.skippedSeen, 1);
  assert.equal(ctx.calls.http.filter((c) => c.method === 'GET').length, 1);
  assert.ok(!ctx.calls.http.some((c) => c.url === detailUrl(LSEG, KYC)));
});

test('a board without Sri Lanka roles gives nothing; a broken board is skipped, not fatal', async () => {
  const other = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Ext/jobs';
  const ctx = ctxFor({
    boards: { workday: ['acme|wd1|Ext', 'lseg|wd3|Careers', 'gone|wd5|X'] },
    json: {
      [other]: { total: 5, jobPostings: [], facets: [{ facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locationCountry', values: [{ descriptor: 'India', id: 'i', count: 5 }] }] }] },
      [SEARCH]: searchRoute,
      [detailUrl(LSEG, KYC)]: fx('lseg-detail-kyc.json'),
    },
  });
  const r = await adapter.scan(ctx);
  assert.equal(r.jobs.length, 1);
  assert.ok(ctx.logs.some((l) => /board failed, skipped \(gone\|wd5\|X: search: HTTP 404\)/.test(l)));
  await assert.rejects(adapter.scan(fixtureContext({ source: 'workday', boards: { workday: ['gone|wd5|X'] } })), /Every workday board failed/);
});

test('recheck: 200 alive, 404 and 403/S22 closed, other 403 unknown', async () => {
  const job = { source_url: `https://lseg.wd3.myworkdayjobs.com/Careers${KYC}`, external_id: 'lseg/Careers:R0124513' };
  const url = detailUrl(LSEG, KYC);
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [url]: fx('lseg-detail-kyc.json') } })), 'alive');
  assert.equal(await adapter.recheck(job, fixtureContext({})), 'closed', 'no fixture = 404');
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [url]: { errorCode: 'S22', httpStatus: 403 } }, status: { [url]: 403 } })), 'closed');
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [url]: '<html>blocked</html>' }, status: { [url]: 403 } })), 'unknown');
  assert.equal(await adapter.recheck(job, fixtureContext({ json: { [url]: {} }, status: { [url]: 503 } })), 'unknown');
  assert.equal(await adapter.recheck({ source_url: 'https://example.com/x', external_id: 'x' }, fixtureContext({})), 'unknown');
});

test('probe counts the board and its Sri Lanka postings', async () => {
  const ctx = ctxFor();
  const p = await probe(ctx.http, { name: 'lseg|wd3|Careers', company: 'LSEG' });
  assert.equal(p.valid, true);
  assert.equal(p.total_postings, 664);
  assert.equal(p.sri_lanka_postings, 31);
  assert.equal(p.sample_titles.length, 5);
  const bad = await probe(fixtureContext({ status: { [SEARCH]: 422 }, json: { [SEARCH]: {} } }).http, 'lseg|wd3|Careers');
  assert.equal(bad.valid, false);
  assert.match(bad.reason!, /site "Careers" is wrong/);
});

test('helpers', () => {
  assert.equal(postingId('/job/Horana-Sri-Lanka/Shift-Engineer_R-1191550-1'), 'R-1191550-1');
  const now = new Date('2026-11-15T04:00:00Z');
  assert.equal(postedOnDate('Posted Today', now), '2026-11-15');
  assert.equal(postedOnDate('Posted 3 Days Ago', now), '2026-11-12');
  assert.equal(postedOnDate('Posted 30+ Days Ago', now), '2026-10-16');
  assert.equal(postedOnDate('', now), null);
});

test('parsePostingUrl reads the myworkdaysite.com/recruiting form too (I1: Sysco LABS links, seen live)', async () => {
  const { parsePostingUrl } = await import('../src/sources/workday/parse.ts');
  assert.deepEqual(
    parsePostingUrl('https://wd5.myworkdaysite.com/recruiting/sysco/syscocareers/job/Sysco-LABS-----Sri-Lanka/Senior-Software-Engineer_R274043'),
    { tenant: 'sysco', wd: 'wd5', site: 'syscocareers', path: '/job/Sysco-LABS-----Sri-Lanka/Senior-Software-Engineer_R274043' },
  );
  assert.equal(parsePostingUrl('https://jll.wd1.myworkdayjobs.com/jllcareers/job/Colombo-Sri-Lanka/X_REQ1')?.tenant, 'jll');
});
