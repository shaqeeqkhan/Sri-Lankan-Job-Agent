import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/hotjobs/index.ts';
import { SITEMAP_URL, decodeFlight, externalIdFromUrl, parseDetail, parseSitemap, resolveFlightText, salaryText } from '../src/sources/hotjobs/parse.ts';
import { fixtureContext, parseJsonLd, readFixture } from './source-helpers.ts';

const SITEMAP = readFixture('hotjobs', 'sitemap-jobs.xml');
const D8745 = readFixture('hotjobs', 'detail-8745.html');
const D8790 = readFixture('hotjobs', 'detail-8790.html');
const U8745 = 'https://hotjobs.lk/jobs/production-assistant/8745';
const U8790 = 'https://hotjobs.lk/jobs/paratha-2f-chapathi-makers/8790';
const U8302 = 'https://hotjobs.lk/jobs/sales-executives/8302';
const U8281 = 'https://hotjobs.lk/jobs/sales-executives/8281';
const NOW = new Date('2026-11-15T04:00:00Z');

test('hotjobs: external id from job URLs', () => {
  assert.equal(externalIdFromUrl(U8745), '8745');
  assert.equal(externalIdFromUrl('https://www.hotjobs.lk/jobs/x/8745/?utm_source=fb'), '8745');
  assert.equal(externalIdFromUrl('https://hotjobs.lk/jobs'), null);
  assert.equal(externalIdFromUrl('https://hotjobs.lk/blog/some-post/12'), null);
});

test('hotjobs: sitemap parses to job entries, newest id first', () => {
  const e = parseSitemap(SITEMAP);
  assert.deepEqual(e.map((x) => x.external_id), ['8790', '8745', '8302', '8281']);
  assert.equal(e[1].url, U8745);
  assert.equal(e[1].lastmod, '2026-11-11T09:17:00.057Z');
});

test('hotjobs: detail page → structured fields from JSON-LD and the job record', () => {
  const { job, active } = parseDetail(D8745, parseJsonLd(D8745), U8745, NOW);
  assert.equal(active, true);
  assert.ok(job);
  assert.equal(job.title, 'Production Assistant');
  assert.equal(job.company, 'Finagle Lanka (Pvt) Ltd');
  assert.equal(job.location, 'Ja-Ela');
  assert.equal(job.closing_date, '2026-12-09');
  assert.equal(job.posted_at, '2026-11-11');
  assert.equal(job.category, 'Hospitality, Restaurants & Tourism');
  assert.equal(job.employment_type, 'Permanent');
  assert.equal(job.salary_text, 'Negotiable');
  assert.equal(job.apply_method, 'portal');
  assert.equal(job.apply_url, U8745);
  assert.equal(job.remote, false);
  assert.equal(job.country_code, 'LK');
  assert.equal(job.external_id, '8745');
  assert.equal(job.source_url, U8745);
  assert.equal(job.scraped_at, NOW.toISOString());
  assert.equal(job.is_image_ad, false, 'an advert image with a full text description is not an image ad');
  assert.match(job.description ?? '', /^<p>Production Assistant<\/p>/);
  assert.equal(job.apply_email, undefined, 'the hidden recruiter inbox is never used');
});

test('hotjobs: a foreign posting, and a description held in a flight text chunk', () => {
  const flight = decodeFlight(D8790);
  assert.match(resolveFlightText(flight, '$48') ?? '', /^<p>PARATHA \/ CHAPATHI MAKERS<\/p>[\s\S]*<\/ul>$/);
  const { job } = parseDetail(D8790, parseJsonLd(D8790), U8790, NOW);
  assert.ok(job);
  assert.equal(job.title, 'PARATHA / CHAPATHI MAKERS');
  assert.equal(job.location, 'Muscat, Oman');
  assert.equal(job.country_code, 'OM', 'enumData.country wins over the JSON-LD addressCountry "LK"');
  assert.match(job.description ?? '', /OMR 110–130/);
  assert.equal(job.closing_date, '2026-12-11');
});

test('hotjobs: "external" applications use the employer link from the record', () => {
  const ext = D8745.replace('\\"receiveApplications\\": \\"portal\\"', '\\"receiveApplications\\": \\"external\\", \\"receiveApplicationsUrl\\": \\"https://www.careers-page.com/intalentasia/job/7XV4W6V3\\"');
  assert.notEqual(ext, D8745);
  const { job } = parseDetail(ext, parseJsonLd(ext), U8745, NOW);
  assert.equal(job?.apply_url, 'https://www.careers-page.com/intalentasia/job/7XV4W6V3');
  assert.equal(job?.apply_method, null, 'left for jobs scan to infer');
});

test('hotjobs: salary object, and image ads', () => {
  assert.equal(salaryText({ salary: { fromSalary: '0', currency: '1', salary: '100000', type: 'Month' } }), '100,000 / month');
  assert.equal(salaryText({ salary: { fromSalary: '80000', salary: '100000', type: 'Month' } }), '80,000–100,000 / month');
  assert.equal(salaryText({ salaryValue: '' }), null);
  const imageOnly = D8745.replace(/\\"description\\": \\"<p>Production Assistant.*?<\/ul><p><br><\/p>\\"/, '\\"description\\": \\"<p>See the image</p>\\"');
  assert.notEqual(imageOnly, D8745);
  const { job } = parseDetail(imageOnly, parseJsonLd(imageOnly), U8745, NOW);
  assert.equal(job?.is_image_ad, true);
});

test('hotjobs: scan skips seen ids, defers a failed detail, and fetches newest first', async () => {
  const ctx = fixtureContext({
    source: 'hotjobs',
    json: { [SITEMAP_URL]: SITEMAP },
    pages: { [U8790]: D8790, [U8745]: D8745, [U8302]: '<html><body>redesigned</body></html>' },
    seen: ['8281'],
  });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 4);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['8790', '8745']);
  assert.deepEqual(r.deferred, ['8302'], 'drifted detail is deferred, not stored thin');
  assert.deepEqual(ctx.calls.pages.map((p) => p.url), [U8790, U8745, U8302]);
  assert.equal(ctx.calls.pages[0].req?.kind, 'detail');
  assert.deepEqual(ctx.calls.http.map((c) => c.url), [SITEMAP_URL]);
});

test('hotjobs: max_details caps detail fetches', async () => {
  const ctx = fixtureContext({ source: { id: 'hotjobs', max_details: 1 }, json: { [SITEMAP_URL]: SITEMAP }, pages: { [U8790]: D8790 } });
  const r = await adapter.scan(ctx);
  assert.equal(ctx.calls.pages.length, 1);
  assert.equal(r.jobs.length, 1);
});

test('hotjobs: an unexpected sitemap or a dead one is a whole-source failure', async () => {
  await assert.rejects(adapter.scan(fixtureContext({ source: 'hotjobs', json: { [SITEMAP_URL]: '<html>maintenance</html>' } })), /drift/);
  await assert.rejects(adapter.scan(fixtureContext({ source: 'hotjobs' })), /HTTP 404/);
});

test('hotjobs: recheck', async () => {
  const ctx = fixtureContext({
    source: 'hotjobs',
    pages: {
      [U8745]: D8745,
      'https://hotjobs.lk/jobs/x/1': D8745.replace('\\"status\\": \\"Active\\"', '\\"status\\": \\"Expired\\"').replaceAll('8745', '1'),
      'https://hotjobs.lk/jobs/x/2': { ok: false, status: 503, block: { reason: 'http', detail: 'HTTP 503' } },
      'https://hotjobs.lk/jobs/x/3': '<html>not a job page</html>',
    },
  });
  const check = (url: string) => adapter.recheck({ source_url: url, external_id: externalIdFromUrl(url)! }, ctx);
  assert.equal(await check(U8745), 'alive');
  assert.equal(await check('https://hotjobs.lk/jobs/x/1'), 'closed', 'status not Active');
  assert.equal(await check('https://hotjobs.lk/jobs/x/9'), 'closed', 'hard 404');
  assert.equal(await check('https://hotjobs.lk/jobs/x/2'), 'unknown', '503 is not a signal');
  assert.equal(await check('https://hotjobs.lk/jobs/x/3'), 'unknown', 'unparseable page');
  const later = fixtureContext({ source: 'hotjobs', now: new Date('2026-12-20T00:00:00Z'), pages: { [U8745]: D8745 } });
  assert.equal(await adapter.recheck({ source_url: U8745, external_id: '8745' }, later), 'closed', 'closing date passed');
});

test('hotjobs: a fetched posting that is not Active is dropped and reported, so jobs scan marks it seen', async () => {
  const expired = D8745.replace('\\"status\\": \\"Active\\"', '\\"status\\": \\"Expired\\"');
  assert.notEqual(expired, D8745, 'fixture has a status field');
  const ctx = fixtureContext({ source: 'hotjobs', json: { [SITEMAP_URL]: SITEMAP }, pages: { [U8790]: D8790, [U8745]: expired }, seen: ['8281', '8302'] });
  const r = await adapter.scan(ctx);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['8790']);
  assert.deepEqual(r.dropped, ['8745']);
  assert.deepEqual(r.deferred, []);
});
