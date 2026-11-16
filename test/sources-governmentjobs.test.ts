import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/governmentjobs/index.ts';
import { LISTING_URL, governmentjobsId, parseImageView, parseListing, toJob } from '../src/sources/governmentjobs/parse.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

const listing = readFixture('governmentjobs', 'listing.html');
const imageView = readFixture('governmentjobs', 'image-view-lpyim6U=-si.html');
const detail = readFixture('governmentjobs', 'detail-lpyim6U=.html');
const B = 'https://governmentjobs.lk';
const IV_U = `${B}/image-view.php?vid=lpyim6U=&type=si`;
const IV_Q = `${B}/image-view.php?vid=lpyim6Q=&type=en`;
const IV_Y = `${B}/image-view.php?vid=lpyil6Y=&type=en`;
const DETAIL_U = `${B}/vacancy_details.php?aid=lpyim6U=`;

test('governmentjobs: external id is the aid parameter', () => {
  assert.equal(governmentjobsId(DETAIL_U), 'lpyim6U=');
  assert.equal(governmentjobsId('https://governmentjobs.lk/image-view.php?vid=lpyim6U='), null);
  assert.equal(governmentjobsId('https://example.lk/vacancy_details.php?aid=x'), null);
});

test('governmentjobs: listing cards carry title, closing date, ref, institution and ad links', () => {
  const cards = parseListing(listing);
  assert.deepEqual(cards.map((c) => c.external_id), ['lpyim6U=', 'lpyim6Q=', 'lpyim6M=', 'lpyil6Y=']);
  const [u, q, m] = cards;
  assert.equal(u.title, 'Works Supervisor (Maintenance) - Gampaha Wickramarachchi University of Indigenous Medicine');
  assert.equal(u.url, DETAIL_U);
  assert.equal(u.closing_date, '2026-11-19');
  assert.equal(u.published, '2026-11-10');
  assert.equal(u.ref_no, 'G-017486');
  assert.equal(u.institution, 'Gampaha Wickramarachchi Ayurveda Institute');
  assert.equal(u.source_note, 'gwu.ac.lk (2026.11.04)');
  assert.deepEqual(u.images, [{ lang: 'si', url: IV_U }]);
  assert.deepEqual(u.links, []);
  assert.deepEqual(q.images, [{ lang: 'en', url: IV_Q }]);
  assert.deepEqual(q.links, [{ label: 'Application', url: 'https://drive.google.com/file/d/1yTjtv6Zmd6KpPzFokAmpBJGAZ9p_DA31/view?usp=sharing' }]);
  assert.equal(m.title, 'Driver (Limited) - Ministry of Health & Mass Media');
  assert.deepEqual(m.images, []);
  assert.deepEqual(m.ad_files, ['https://drive.google.com/file/d/11jBBoxFejOkr1gl3ykzBQ4Ou2bL_Mv31/view?usp=sharing']);
});

test('governmentjobs: image-view page gives the ad images; the job is an image ad', () => {
  const files = parseImageView(imageView);
  assert.deepEqual(files, [
    'https://s3-ap-southeast-1.amazonaws.com/mytutor.lk/vacancy/179429261428-sin-1.jpg',
    'https://s3-ap-southeast-1.amazonaws.com/mytutor.lk/vacancy/179429261428-sin-2.jpg',
  ]);
  const job = toJob(parseListing(listing)[0], files, '2026-11-15T04:00:00.000Z');
  assert.equal(job.is_image_ad, true);
  assert.equal(job.company, 'Gampaha Wickramarachchi Ayurveda Institute');
  assert.equal(job.closing_date, '2026-11-19');
  assert.equal(job.posted_at, '2026-11-10');
  assert.equal(job.category, 'Government');
  assert.equal(job.country_code, 'LK');
  assert.equal(job.apply_url, null, 'how to apply is in the image');
  assert.match(job.description ?? '', /179429261428-sin-1\.jpg/);
  assert.match(job.description ?? '', /G-017486/);

  const withForm = toJob(parseListing(listing)[1], [], 'x');
  assert.match(withForm.apply_instructions ?? '', /Application form: https:\/\/drive\.google\.com/);
  assert.equal(withForm.apply_url, null, 'a Drive form is a document, not an apply link');
  const online = toJob({ ...parseListing(listing)[1], links: [{ label: 'Application', url: 'https://recruit.srilankan.com/jobs/Careers/700027000032982140/x' }] }, [], 'x');
  assert.equal(online.apply_url, 'https://recruit.srilankan.com/jobs/Careers/700027000032982140/x');
  assert.equal(online.apply_method, 'portal');
});

test('governmentjobs: scan skips closed and seen cards, defers failed image pages', async () => {
  const ctx = fixtureContext({
    source: 'governmentjobs',
    now: new Date('2026-11-16T04:00:00Z'), // lpyil6Y= closed on 2026-11-15
    pages: { [LISTING_URL]: listing, [IV_U]: imageView, [IV_Q]: '<html>no images here</html>' },
  });
  const r = await adapter.scan(ctx);
  assert.equal(r.listed, 4);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['lpyim6U=', 'lpyim6M=']);
  assert.deepEqual(r.deferred, ['lpyim6Q='], 'image page drifted');
  assert.ok(!ctx.calls.pages.some((p) => p.url === IV_Y), 'closed vacancy not fetched');
  assert.equal(r.jobs[1].is_image_ad, true, 'the Drive file is the ad');
  assert.match(r.jobs[1].description ?? '', /drive\.google\.com\/file\/d\/11jBBox/);
  assert.equal(ctx.calls.pages[0].req?.kind, 'listing');
  assert.ok(ctx.calls.pages.every((p) => p.req?.expect));

  const again = fixtureContext({ source: 'governmentjobs', pages: { [LISTING_URL]: listing }, seen: ['lpyim6U=', 'lpyim6Q=', 'lpyil6Y='] });
  const r2 = await adapter.scan(again);
  assert.equal(r2.skippedSeen, 3);
  assert.deepEqual(r2.jobs.map((j) => j.external_id), ['lpyim6M=']);
});

test('governmentjobs: an unreadable or drifted listing is a whole-source failure', async () => {
  await assert.rejects(adapter.scan(fixtureContext({ source: 'governmentjobs' })), /governmentjobs: listing/);
  await assert.rejects(
    adapter.scan(fixtureContext({ source: 'governmentjobs', pages: { [LISTING_URL]: '<html>Under maintenance</html>' } })),
    /governmentjobs: listing/,
  );
});

test('governmentjobs: recheck reads the closing date on the vacancy page', async () => {
  const job = { source_url: DETAIL_U, external_id: 'lpyim6U=' };
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'governmentjobs', pages: { [DETAIL_U]: detail } })), 'alive');
  assert.equal(
    await adapter.recheck(job, fixtureContext({ source: 'governmentjobs', pages: { [DETAIL_U]: detail }, now: new Date('2026-11-20T04:00:00Z') })),
    'closed',
  );
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'governmentjobs', pages: { [DETAIL_U]: '' } })), 'unknown', 'empty page');
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'governmentjobs' })), 'unknown');
});
