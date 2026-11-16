import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/xpressjobs/index.ts';
import { detailApiUrl, externalIdFromUrl, mapDetail, parseSearchPage, parseSitemap, salaryText, searchApiUrl, SITEMAP_URL } from '../src/sources/xpressjobs/parse.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

const fx = (name: string) => readFixture('xpressjobs', name);
const detail = (name: string) => JSON.parse(fx(name));
const SCRAPED = '2026-11-15T04:00:00.000Z';
const D = (id: string) => detailApiUrl(id);

test('xpressjobs: sitemap → job entries newest id first, non-job URLs ignored', () => {
  const entries = parseSitemap(fx('sitemap.xml'));
  assert.deepEqual(entries.map((e) => e.id), ['352788', '351183', '348266', '267782']);
  assert.equal(entries[0].url, 'https://xpress.jobs/jobs/view/352788/shift-manager-supervisor-colombo-kandy-burger-king');
  assert.equal(entries[0].lastmod, '2026-11-13');
  assert.equal(entries[3].lastmod, '2026-04-10');
});

test('xpressjobs: external id from a job URL', () => {
  assert.equal(externalIdFromUrl('https://xpress.jobs/jobs/view/352788/shift-manager'), '352788');
  assert.equal(externalIdFromUrl('https://xpress.jobs/jobs/view/352788'), '352788');
  assert.equal(externalIdFromUrl('https://xpressjobs.lk/jobs/view/1234/x?utm_source=fb'), '1234');
  assert.equal(externalIdFromUrl('https://xpress.jobs/jobs/accounting-jobs'), null);
});

test('xpressjobs: detail JSON → ScrapedJob with structured fields', () => {
  const j = mapDetail(detail('detail-352788.json'), { sourceUrl: 'https://xpress.jobs/jobs/view/352788/shift-manager-supervisor-colombo-kandy-burger-king', scrapedAt: SCRAPED })!;
  assert.equal(j.title, 'Shift Manager / Supervisor | Colombo & Kandy');
  assert.equal(j.company, 'Burger King');
  assert.equal(j.location, 'Colombo, Western Province; Kandy, Central Province');
  assert.equal(j.category, 'FMCG/ Food Industry');
  assert.equal(j.closing_date, '2026-11-27');
  assert.equal(j.posted_at, '2026-11-13T01:56:45.377');
  assert.equal(j.employment_type, 'Full-Time');
  assert.equal(j.salary_text, null, '"Any" is no salary');
  assert.equal(j.apply_method, 'portal');
  assert.equal(j.apply_url, j.source_url);
  assert.equal(j.is_image_ad, false);
  assert.equal(j.remote, false);
  assert.equal(j.country_code, 'LK');
  assert.equal(j.external_id, '352788');
  assert.equal(j.scraped_at, SCRAPED);
  assert.match(j.description!, /Softlogic Restaurants/);
  assert.match(j.description!, /Experience: 1-2 years/);
});

test('xpressjobs: a redirected ad applies at its own link; its banner image is kept', () => {
  const j = mapDetail(detail('detail-267782.json'), { sourceUrl: null, scrapedAt: SCRAPED })!;
  assert.match(j.apply_url!, /^https:\/\/docs\.google\.com\/forms\//);
  assert.equal(j.apply_method, null, 'left for the store to infer');
  assert.equal(j.source_url, 'https://xpress.jobs/jobs/view/267782/retail-sales-associate-fixed-term-contract-commercial-bank-of-ceylon-plc');
  assert.match(j.description!, /Advert image: .*https:\/\/cdn\.xpress\.jobs\/Vacancies\/DescriptionImage_267782/);
  assert.equal(j.is_image_ad, false, 'it also has text');
  // The same ad with no text is an image ad.
  const bare = mapDetail({ ...detail('detail-267782.json'), jobInfo: '<p><br></p>' }, { sourceUrl: null, scrapedAt: SCRAPED })!;
  assert.equal(bare.is_image_ad, true);
});

test('xpressjobs: salary only from numeric min/max (LKR per month), and foreign jobs are not LK', () => {
  assert.equal(salaryText({ minSalary: '85000', maxSalary: '110000' }), 'LKR 85,000–110,000 per month');
  assert.equal(salaryText({ minSalary: '60000', maxSalary: 'Any' }), 'LKR 60,000 per month');
  assert.equal(salaryText({ minSalary: 'Any', maxSalary: 'Any', salaryRange: 'Any' }), null);
  assert.equal(salaryText({ minSalary: 'Any', salaryRange: 'Negotiable' }), 'Negotiable');
  const base = detail('detail-352788.json');
  const foreign = mapDetail({ ...base, jobItem: { ...base.jobItem, locations: ' Foreign Job, Overseas' } }, { scrapedAt: SCRAPED })!;
  assert.equal(foreign.country_code, null);
  const mixed = mapDetail({ ...base, jobItem: { ...base.jobItem, locations: ' Colombo, Western Province; Foreign Job, Overseas' } }, { scrapedAt: SCRAPED })!;
  assert.equal(mixed.country_code, 'LK');
  assert.equal(mixed.location, 'Colombo, Western Province');
  const remote = mapDetail({ ...base, jobItem: { ...base.jobItem, remote: true } }, { scrapedAt: SCRAPED })!;
  assert.equal(remote.remote, true);
});

test('xpressjobs scan: sitemap, skip seen, fetch details newest first, defer failures, drop unpublished', async () => {
  const ctx = fixtureContext({
    source: 'xpressjobs',
    json: {
      [SITEMAP_URL]: fx('sitemap.xml'),
      [D('352788')]: detail('detail-352788.json'),
      [D('267782')]: detail('detail-267782.json'),
    },
    status: { [D('348266')]: 500 },
    seen: ['351183'],
  });
  const r = await adapter.scan(ctx);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['352788', '267782']);
  assert.equal(r.listed, 4);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.deferred, ['348266']);
  assert.deepEqual(ctx.calls.http.map((c) => c.url), [SITEMAP_URL, D('352788'), D('348266'), D('267782')]);
  assert.equal(r.jobs[0].source_url, 'https://xpress.jobs/jobs/view/352788/shift-manager-supervisor-colombo-kandy-burger-king');
  assert.equal(ctx.calls.pages.length, 0, 'JSON and sitemap go through ctx.http only');
});

test('xpressjobs scan: 204 means no longer published (not deferred); max_details caps detail fetches', async () => {
  const gone = fixtureContext({
    source: { id: 'xpressjobs' },
    json: { [SITEMAP_URL]: fx('sitemap.xml'), [D('352788')]: detail('detail-352788.json') },
    status: { [D('351183')]: 204, [D('348266')]: 204, [D('267782')]: 204 },
  });
  const r = await adapter.scan(gone);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['352788']);
  assert.deepEqual(r.deferred, []);

  const capped = fixtureContext({
    source: { id: 'xpressjobs', max_details: 1 },
    json: { [SITEMAP_URL]: fx('sitemap.xml'), [D('352788')]: detail('detail-352788.json') },
  });
  const c = await adapter.scan(capped);
  assert.equal(c.jobs.length, 1);
  assert.equal(capped.calls.http.length, 2);
});

test('xpressjobs scan: `since` skips old sitemap entries without fetching them', async () => {
  const ctx = fixtureContext({
    source: 'xpressjobs',
    since: new Date('2026-11-10T00:00:00Z'),
    json: { [SITEMAP_URL]: fx('sitemap.xml'), [D('352788')]: detail('detail-352788.json'), [D('351183')]: detail('detail-352788.json') },
  });
  const r = await adapter.scan(ctx);
  assert.deepEqual(ctx.calls.http.map((c) => c.url), [SITEMAP_URL, D('352788'), D('351183')], '348266 (Nov 2) and 267782 (Apr) are older');
  assert.equal(r.jobs.length, 2);
});

test('xpressjobs scan: falls back to the search API when the sitemap is missing', async () => {
  const ctx = fixtureContext({
    source: { id: 'xpressjobs', options: { fallback_pages: 2, page_size: 3 } },
    json: {
      [searchApiUrl(1, 3)]: JSON.parse(fx('search-page1.json')),
      [searchApiUrl(2, 3)]: [],
      [D('351183')]: detail('detail-352788.json'),
    },
  });
  const r = await adapter.scan(ctx);
  const page = parseSearchPage(JSON.parse(fx('search-page1.json')));
  assert.deepEqual(page.ids, ['351183', '348586', '341501']);
  assert.equal(page.total, 4216);
  assert.equal(r.listed, 3);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['352788'], 'body of the served detail');
  assert.deepEqual(r.deferred, ['348586', '341501']);
  assert.match(ctx.logs[0], /sitemap unavailable/);
});

test('xpressjobs scan: whole-source failure and API drift throw', async () => {
  await assert.rejects(adapter.scan(fixtureContext({ source: 'xpressjobs' })), /neither the sitemap nor the search API/);
  const drift = fixtureContext({
    source: 'xpressjobs',
    json: { [SITEMAP_URL]: fx('sitemap.xml'), [D('352788')]: { data: [] }, [D('351183')]: { data: [] }, [D('348266')]: { data: [] }, [D('267782')]: { data: [] } },
  });
  await assert.rejects(adapter.scan(drift), /unexpected shape/);
});

test('xpressjobs recheck: published → alive; archived, expired or 204 → closed; otherwise unknown', async () => {
  const job = { source_url: 'https://xpress.jobs/jobs/view/352788/x', external_id: '352788' };
  const alive = fixtureContext({ source: 'xpressjobs', json: { [D('352788')]: detail('detail-352788.json') } });
  assert.equal(await adapter.recheck(job, alive), 'alive');
  const later = fixtureContext({ source: 'xpressjobs', now: new Date('2026-12-01T00:00:00Z'), json: { [D('352788')]: detail('detail-352788.json') } });
  assert.equal(await adapter.recheck(job, later), 'closed', 'expiry 2026-11-27 has passed');
  const archived = fixtureContext({ source: 'xpressjobs', json: { [D('340005')]: detail('detail-340005-archived.json') } });
  assert.equal(await adapter.recheck({ source_url: 'https://xpress.jobs/jobs/view/340005/x', external_id: '340005' }, archived), 'closed');
  const unpublished = fixtureContext({ source: 'xpressjobs', status: { [D('352788')]: 204 } });
  assert.equal(await adapter.recheck(job, unpublished), 'closed');
  const error = fixtureContext({ source: 'xpressjobs', status: { [D('352788')]: 503 } });
  assert.equal(await adapter.recheck(job, error), 'unknown');
  const odd = fixtureContext({ source: 'xpressjobs', json: { [D('352788')]: { hello: 1 } } });
  assert.equal(await adapter.recheck(job, odd), 'unknown');
  assert.equal(await adapter.recheck({ source_url: 'https://xpress.jobs/jobs', external_id: 'x' }, odd), 'unknown');
});
