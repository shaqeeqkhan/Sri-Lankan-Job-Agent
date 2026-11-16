import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/jobeka/index.ts';
import { externalIdFromUrl, listingUrl, parseDetail, parseListing, placeText, salaryText } from '../src/sources/jobeka/parse.ts';
import { fixtureContext, parseJsonLd, readFixture } from './source-helpers.ts';

const P1 = readFixture('jobeka', 'listing-page1.html');
const P4 = readFixture('jobeka', 'listing-page4.html');
const D180 = readFixture('jobeka', 'detail-1364180.html');
const DEXP = readFixture('jobeka', 'detail-expired-1363601.html');
const U180 = 'https://jobeka.lk/jobs/Sales-Representative-1364180';
const U184 = 'https://jobeka.lk/jobs/Medical-Coordinator-cum-Phlebotomist-1364184';
const U188 = 'https://jobeka.lk/jobs/Remote-Retyping-and-Data-Entry-Assistant-1364188';
const UEXP = 'https://jobeka.lk/jobs/Diligent-Consulting-Group-Sales-Executive-2025-01-21-1363601';
const NOW = new Date('2026-11-15T04:00:00Z');

test('jobeka: external id from job URLs', () => {
  assert.equal(externalIdFromUrl(U180), '1364180');
  assert.equal(externalIdFromUrl('/jobs/Hayleys-Plant-Manager-2025-01-17-1363577'), '1363577');
  assert.equal(externalIdFromUrl('https://jobeka.lk/jobs/%E0%B6%9A%E0%B7%8F-1364051'), '1364051');
  assert.equal(externalIdFromUrl('https://jobeka.lk/jobs'), null);
  assert.equal(externalIdFromUrl('https://jobeka.lk/company/Galleon-Lanka-161078'), null);
  assert.equal(listingUrl(1), 'https://jobeka.lk/jobs');
  assert.equal(listingUrl(3), 'https://jobeka.lk/jobs?page=3');
});

test('jobeka: listing cards, featured repeats merged', () => {
  const cards = parseListing(P1);
  assert.deepEqual(cards.map((c) => c.external_id), ['1364188', '1364184', '1364181', '1364180']);
  const c = cards[1];
  assert.equal(c.url, U184);
  assert.equal(c.title, 'Medical Coordinator cum Phlebotomist');
  assert.equal(c.company, 'MEDIFIT Healthcare (Pvt) Ltd');
  assert.equal(c.place, 'Colombo > Colombo 3');
  assert.equal(c.deadline, '2026-11-30');
  assert.ok(cards.every((x) => x.deadline), 'the dated copy wins over the featured repeat');
});

test('jobeka: detail page fields', () => {
  const { job, expired } = parseDetail(D180, parseJsonLd(D180), U180, NOW);
  assert.equal(expired, false);
  assert.ok(job);
  assert.equal(job.title, 'Sales Representative', 'the page heading, not the JSON-LD title with " in Homagama"');
  assert.equal(job.company, 'Galleon Lanka');
  assert.equal(job.location, 'Homagama, Colombo');
  assert.equal(job.closing_date, '2026-12-10');
  assert.equal(job.posted_at, '2026-10-14');
  assert.equal(job.employment_type, 'FULL_TIME');
  assert.equal(job.salary_text, null, '"Unspecified" is not a salary');
  assert.equal(job.apply_phone, '0700000003');
  assert.equal(job.apply_method, 'portal');
  assert.equal(job.apply_url, 'https://jobeka.lk/apply-now?jobID=1364180');
  assert.equal(job.country_code, 'LK');
  assert.equal(job.is_image_ad, false);
  assert.match(job.description ?? '', /^<p>Job Vacancy – Sales Representative<\/p>/);
  assert.equal(job.external_id, '1364180');
  assert.equal(job.source_url, U180);
});

test('jobeka: helpers', () => {
  assert.equal(placeText('Colombo > Colombo'), 'Colombo');
  assert.equal(placeText('Pettah  > Pettah'), 'Pettah');
  assert.equal(placeText('Gampaha'), 'Gampaha');
  assert.equal(salaryText('10000 - 20000'), '10000 - 20000', 'no currency guessed from the LKR label');
  assert.equal(salaryText('Negotiable'), 'Negotiable');
  assert.equal(salaryText('Unspecified'), null);
});

test('jobeka: expired detail is flagged', () => {
  const { job, expired } = parseDetail(DEXP, parseJsonLd(DEXP), UEXP, NOW);
  assert.equal(expired, true);
  assert.equal(job?.closing_date, '2025-02-19');
});

test('jobeka: scan pages until a page has no open card, skips expired and seen, defers failures', async () => {
  const ctx = fixtureContext({
    source: 'jobeka',
    pages: {
      [listingUrl(1)]: P1,
      [listingUrl(2)]: P4, // every card on it is expired: paging stops after it
      [U180]: D180,
      [U188]: '<html><body>Server Error</body></html>',
    },
    seen: ['1364184'],
  });
  const r = await adapter.scan(ctx);
  // 1364181 (deadline 2026-11-06) is expired on the listing; 1364188 closes today and stays.
  assert.equal(r.listed, 3);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['1364180']);
  assert.deepEqual(r.deferred, ['1364188']);
  assert.deepEqual(ctx.calls.pages.map((p) => p.url), [listingUrl(1), listingUrl(2), U188, U180]);
  assert.equal(ctx.calls.pages[0].req?.kind, 'listing');
});

test('jobeka: a drifted first listing page is a whole-source failure; a later one only stops paging', async () => {
  await assert.rejects(adapter.scan(fixtureContext({ source: 'jobeka', pages: { [listingUrl(1)]: '<html>redesign</html>' } })), /jobeka: listing page unavailable \(drift/);
  const ctx = fixtureContext({ source: 'jobeka', pages: { [listingUrl(1)]: P1, [U180]: D180 }, seen: ['1364184', '1364188'] });
  const r = await adapter.scan(ctx);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['1364180']);
  assert.match(ctx.logs.join('\n'), /listing page 2 unavailable/);
});

test('jobeka: recheck', async () => {
  const ctx = fixtureContext({
    source: 'jobeka',
    pages: { [U180]: D180, [UEXP]: DEXP, 'https://jobeka.lk/jobs/Gone-1': '<html><title>Browse 10164 jobs</title></html>' },
  });
  const check = (url: string) => adapter.recheck({ source_url: url, external_id: externalIdFromUrl(url)! }, ctx);
  assert.equal(await check(U180), 'alive');
  assert.equal(await check(UEXP), 'closed', '"This job is expired"');
  assert.equal(await check('https://jobeka.lk/jobs/Gone-1'), 'unknown', 'soft 404 (redirect to /browse)');
  assert.equal(await check('https://jobeka.lk/jobs/Missing-2'), 'unknown', 'a failed fetch is not a signal here');
  const later = fixtureContext({ source: 'jobeka', now: new Date('2026-12-11T00:00:00Z'), pages: { [U180]: D180 } });
  assert.equal(await adapter.recheck({ source_url: U180, external_id: '1364180' }, later), 'closed', 'deadline passed');
});

test('jobeka: an expired detail page is dropped and reported, so jobs scan marks it seen', async () => {
  const ctx = fixtureContext({ source: 'jobeka', pages: { [listingUrl(1)]: P1, [U180]: DEXP.replaceAll('1363601', '1364180') }, seen: ['1364184', '1364188'] });
  const r = await adapter.scan(ctx);
  assert.deepEqual(r.jobs, []);
  assert.deepEqual(r.dropped, ['1364180']);
});
