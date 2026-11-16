import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/dreamjobs/index.ts';
import { LISTING_URL, dreamjobsSlug, parseDetail, parseIndustries, parseJobLinks } from '../src/sources/dreamjobs/parse.ts';
import { fixtureContext, parseJsonLd, readFixture } from './source-helpers.ts';

const browse = readFixture('dreamjobs', 'browse.html');
const detail = readFixture('dreamjobs', 'detail-32645.html');
const expired = readFixture('dreamjobs', 'expired.html');
const URL1 = 'https://dreamjobs.lk/jobs/internship-flutter-developers-onsite-2';
const ALL = [
  'internship-flutter-developers-onsite-2',
  'senior-software-engineer-software-engineer-php-onsite-8',
  'software-engineer-senior-software-engineer-flutter-onsite-8',
  'sales-officers-freshers',
];

test('dreamjobs: external id is the job slug from the URL', () => {
  assert.equal(dreamjobsSlug(URL1), 'internship-flutter-developers-onsite-2');
  assert.equal(dreamjobsSlug('https://dreamjobs.lk/jobs/32645/apply'), null);
  assert.equal(dreamjobsSlug('https://dreamjobs.lk/jobs/search'), null);
  assert.equal(dreamjobsSlug('https://dreamjobs.lk/industry/it-software-engineers-web'), null);
});

test('dreamjobs: the Browse Jobs page lists every open job with industry counts', () => {
  const links = parseJobLinks(browse);
  assert.deepEqual(links.map((l) => l.external_id), ALL);
  assert.equal(links[0].url, URL1);
  assert.equal(links[0].title, 'Internship- Flutter Developers (Onsite)');
  assert.deepEqual(parseIndustries(browse).map((i) => [i.url, i.count, i.shown]), [
    ['https://dreamjobs.lk/industry/it-software-engineers-web', 3, 3],
    ['https://dreamjobs.lk/industry/sales-marketing-merchandising', 1, 1],
  ]);
});

test('dreamjobs: detail page → JSON-LD fields, image ad, the site apply form', () => {
  const job = parseDetail(detail, parseJsonLd(detail), URL1, '2026-11-15T04:00:00.000Z');
  assert.ok(job);
  assert.equal(job.title, 'Internship- Flutter Developers (Onsite)');
  assert.equal(job.company, 'Elegant Media (Pvt) Ltd');
  assert.equal(job.location, 'Kohuwala');
  assert.equal(job.category, 'IT Software, Engineers & Web');
  assert.equal(job.closing_date, '2026-11-29', 'date part of validThrough, whatever its offset');
  assert.equal(job.posted_at, '2026-10-30');
  assert.equal(job.employment_type, 'Full-Time');
  assert.equal(job.apply_method, 'portal');
  assert.equal(job.apply_url, 'https://dreamjobs.lk/jobs/32645/apply');
  assert.equal(job.is_image_ad, true);
  assert.match(job.description ?? '', /Advertisement image: https:\/\/assets\.dreamjobs\.lk\/images\/content\/202610\/PpQEHGbqXxuK8NL\.jpg/);
  assert.doesNotMatch(job.description ?? '', /Hiring now for/, 'the boilerplate JSON-LD description is dropped');
  assert.equal(job.external_id, 'internship-flutter-developers-onsite-2');
  assert.equal(job.country_code, 'LK');
});

test('dreamjobs: without JSON-LD the HTML fills the fields; an expired page is not a job', () => {
  const noLd = parseDetail(detail, [], URL1, 'x');
  assert.equal(noLd?.title, 'Internship- Flutter Developers (Onsite)');
  assert.equal(noLd?.company, 'Elegant Media (Pvt) Ltd');
  assert.equal(noLd?.closing_date, '2026-11-29', 'from "Applications Close: Sun, 29 Nov 2026"');
  assert.equal(parseDetail(expired, parseJsonLd(expired), 'https://dreamjobs.lk/jobs/early-years-teacher', 'x'), null);
});

test('dreamjobs: scan skips seen slugs, defers failed and drifted details', async () => {
  const ctx = fixtureContext({
    source: 'dreamjobs',
    pages: {
      [LISTING_URL]: browse,
      [URL1]: detail,
      [`https://dreamjobs.lk/jobs/${ALL[1]}`]: '<html><body>a new layout</body></html>',
      [`https://dreamjobs.lk/jobs/${ALL[3]}`]: expired.replace('Early Years Teacher', 'Sales Officers Freshers'),
    },
    seen: [ALL[2]],
  });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 4);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.jobs.map((j) => j.external_id), [ALL[0]]);
  assert.deepEqual(r.deferred, [ALL[1]]);
  assert.equal(ctx.calls.pages[0].req?.kind, 'listing');
  assert.ok(ctx.calls.pages.every((p) => p.req?.expect));
  assert.equal(ctx.calls.pages.length, 4, 'listing + 3 details; no industry page needed');
});

test('dreamjobs: an industry cut short is read from its own page; drifted listing throws', async () => {
  const short = browse.replace('3 Jobs', '5 Jobs');
  const ind = 'https://dreamjobs.lk/industry/it-software-engineers-web';
  const ctx = fixtureContext({
    source: { id: 'dreamjobs', max_details: 0 },
    pages: { [LISTING_URL]: short, [ind]: '<a href="https://dreamjobs.lk/jobs/qa-engineer">QA</a><a href="https://dreamjobs.lk/jobs/sales-officers-freshers">x</a>' },
  });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 5);
  assert.ok(ctx.calls.pages.some((p) => p.url === ind));

  const drift = fixtureContext({ source: 'dreamjobs', pages: { [LISTING_URL]: '<html>maintenance</html>' } });
  await assert.rejects(adapter.scan(drift), /dreamjobs: listing/);
});

test('dreamjobs: recheck', async () => {
  const job = { source_url: URL1, external_id: ALL[0] };
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'dreamjobs', pages: { [URL1]: detail } })), 'alive');
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'dreamjobs', pages: { [URL1]: expired } })), 'closed', 'Apply button and posting data gone');
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'dreamjobs' })), 'closed', '404');
  assert.equal(
    await adapter.recheck(job, fixtureContext({ source: 'dreamjobs', pages: { [URL1]: detail }, now: new Date('2026-12-01T00:00:00Z') })),
    'closed',
    'closing date passed',
  );
  const blocked = fixtureContext({ source: 'dreamjobs', pages: { [URL1]: { ok: false, status: 503, block: { reason: 'http', detail: 'HTTP 503' } } } });
  assert.equal(await adapter.recheck(job, blocked), 'unknown');
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'dreamjobs', pages: { [URL1]: '<html>new site</html>' } })), 'unknown');
});
