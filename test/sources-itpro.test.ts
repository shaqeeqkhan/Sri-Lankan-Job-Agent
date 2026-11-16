import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/itpro/index.ts';
import { RSS_URL, SITEMAP_URL, itproId, parseDetail, parseRss, parseSitemap } from '../src/sources/itpro/parse.ts';
import { closingDateFromText } from '../src/sources/itpro/text.ts';
import { fixtureContext, parseJsonLd, readFixture } from './source-helpers.ts';

const sitemap = readFixture('itpro', 'sitemap.xml');
const rss = readFixture('itpro', 'rss.xml');
const detail = readFixture('itpro', 'detail-15785.html');
const unavailable = readFixture('itpro', 'unavailable.html');
const U = {
  a: 'https://itpro.lk/job/15785/it-operations-manager-at-commercial-lanka-solution/',
  b: 'https://itpro.lk/job/15784/associate-software-engineer-at-intrix-digital/',
  c: 'https://itpro.lk/job/15783/erp-project-manager-at-kaizens-group/',
  old: 'https://itpro.lk/job/10750/php-developer-laravel-at-prime-one-global-pvt-ltd/',
};

test('itpro: external id comes from the /job/<id>/ URL', () => {
  assert.equal(itproId(U.a), '15785');
  assert.equal(itproId('https://itpro.lk/jobs/15785/it-operations-manager/'), '15785');
  assert.equal(itproId('https://itpro.lk/jobs/software-engineering/'), null);
  assert.equal(itproId('https://itpro.lk/about/'), null);
});

test('itpro: sitemap and RSS listings give job URLs newest first, skipping other pages', () => {
  const s = parseSitemap(sitemap);
  assert.deepEqual(s.map((e) => e.external_id), ['15785', '15784', '15783', '10750']);
  assert.deepEqual(s[0], { external_id: '15785', url: U.a, lastmod: '2026-11-15' });
  const r = parseRss(rss);
  assert.deepEqual(r.map((e) => e.external_id), ['15785', '15784']);
  assert.equal(r[0].lastmod, '2026-11-15');
});

test('itpro: detail page → JobPosting fields; the 90-day board expiry gives way to the stated date', () => {
  const job = parseDetail(detail, parseJsonLd(detail), U.a, '2026-11-15T04:00:00.000Z');
  assert.ok(job);
  assert.equal(job.title, 'IT Operations Manager');
  assert.equal(job.company, 'Commercial Lanka Solution');
  assert.equal(job.location, 'Kandy');
  assert.equal(job.category, 'IT and Operations');
  assert.equal(job.employment_type, 'FULL_TIME');
  assert.equal(job.posted_at, '2026-11-15');
  // validThrough is 2027-02-13 (datePosted + 90 days); the ad says "Apply before: 30 November 2026".
  assert.equal(job.closing_date, '2026-11-30');
  assert.equal(job.country_code, 'LK');
  assert.equal(job.apply_method, 'portal');
  assert.equal(job.apply_url, U.a);
  assert.equal(job.external_id, '15785');
  assert.equal(job.source_url, U.a);
  assert.equal(job.is_image_ad, false);
  assert.match(job.description ?? '', /IT Operations Manager to keep our projects/);
});

test('itpro: a validThrough that is not the board default is kept as the closing date', () => {
  const html = detail.replace('"validThrough": "2027-02-13T23:59:59+05:30"', '"validThrough": "2026-12-05T23:59:59+05:30"');
  assert.notEqual(html, detail);
  const job = parseDetail(html, parseJsonLd(html), U.a, 'x');
  assert.equal(job?.closing_date, '2026-12-05');
});

test('itpro: closing date text parser fills nulls only when it is unambiguous', () => {
  assert.equal(closingDateFromText('<p>Apply before: 30 November 2026</p>'), '2026-11-30');
  assert.equal(closingDateFromText('Closing date - Sun, 29 Nov 2026'), '2026-11-29');
  assert.equal(closingDateFromText('Apply before 30 Nov 2026. Deadline: 5 Dec 2026'), null);
  assert.equal(closingDateFromText('We are hiring!'), null);
});

test('itpro: scan skips seen ids, defers failed and drifted details, ignores removed jobs', async () => {
  const ctx = fixtureContext({
    source: 'itpro',
    json: { [SITEMAP_URL]: sitemap },
    pages: {
      [U.a]: detail,
      [U.b]: '<html><body>redesigned page, no data</body></html>', // drift
      [U.old]: unavailable,
      // U.c has no fixture: the fetch fails
    },
    seen: [],
  });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 4);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['15785']);
  assert.deepEqual(r.deferred, ['15784', '15783']);
  assert.equal(r.skippedSeen, 0);
  assert.deepEqual(ctx.calls.http, [{ method: 'GET', url: SITEMAP_URL }]);
  assert.deepEqual(ctx.calls.pages.map((p) => p.url), [U.a, U.b, U.c, U.old]);
  assert.equal(ctx.calls.pages[0].req?.kind, 'detail');
  assert.ok(ctx.calls.pages[0].req?.expect, 'detail fetches pass expect for drift detection');

  const again = fixtureContext({ source: 'itpro', json: { [SITEMAP_URL]: sitemap }, pages: { [U.a]: detail }, seen: ['15784', '15783', '10750'] });
  const r2 = await adapter.scan(again);
  assert.equal(r2.skippedSeen, 3);
  assert.deepEqual(again.calls.pages.map((p) => p.url), [U.a]);
});

test('itpro: max_details caps detail fetches; since drops older sitemap entries', async () => {
  const capped = fixtureContext({ source: { id: 'itpro', max_details: 1 }, json: { [SITEMAP_URL]: sitemap }, pages: { [U.a]: detail } });
  const r = await adapter.scan(capped);
  assert.equal(capped.calls.pages.length, 1);
  assert.equal(r.jobs.length, 1);

  const recent = fixtureContext({ source: 'itpro', json: { [SITEMAP_URL]: sitemap }, pages: { [U.a]: detail }, since: new Date('2026-11-01T00:00:00Z') });
  await adapter.scan(recent);
  assert.ok(!recent.calls.pages.some((p) => p.url === U.old));
});

test('itpro: falls back to RSS when the sitemap is down; throws when both are', async () => {
  const ctx = fixtureContext({ source: 'itpro', json: { [RSS_URL]: rss }, status: { [SITEMAP_URL]: 503 }, pages: { [U.a]: detail }, seen: ['15784'] });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 2);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['15785']);

  const dead = fixtureContext({ source: 'itpro', json: { [SITEMAP_URL]: '<urlset></urlset>' } });
  await assert.rejects(adapter.scan(dead), /itpro: listing .* could not be read/);
});

test('itpro: recheck is closed only on a clear signal', async () => {
  const job = { source_url: U.a, external_id: '15785' };
  const live = fixtureContext({ source: 'itpro', pages: { [U.a]: detail } });
  assert.equal(await adapter.recheck(job, live), 'alive');
  const gone = fixtureContext({ source: 'itpro', pages: { [U.a]: unavailable } });
  assert.equal(await adapter.recheck(job, gone), 'closed');
  const expired = fixtureContext({ source: 'itpro', pages: { [U.a]: detail }, now: new Date('2027-03-01T00:00:00Z') });
  assert.equal(await adapter.recheck(job, expired), 'closed', 'validThrough (the board expiry) has passed');
  const blocked = fixtureContext({ source: 'itpro', pages: { [U.a]: { ok: false, status: 503, block: { reason: 'http', detail: 'HTTP 503' } } } });
  assert.equal(await adapter.recheck(job, blocked), 'unknown');
  const drift = fixtureContext({ source: 'itpro', pages: { [U.a]: '<html>new layout</html>' } });
  assert.equal(await adapter.recheck(job, drift), 'unknown');
});
