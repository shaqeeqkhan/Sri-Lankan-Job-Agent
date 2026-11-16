import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/topjobs/index.ts';
import { adUrl, externalIdFromUrl, LISTING_URL, mapJob, parseAd, parseListing, type ListingRow } from '../src/sources/topjobs/parse.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

const fx = (name: string) => readFixture('topjobs', name);
const SCRAPED = '2026-11-15T04:00:00.000Z';
const U = {
  '1571430': adUrl('0000000385', '0001571430', '0000000505'),
  '1571429': adUrl('DEFZZZ', '0001571429', 'DEFZZZ'),
  '1571428': adUrl('DEFZZZ', '0001571428', 'DEFZZZ'),
  '1570753': adUrl('DEFZZZ', '0001570753', 'DEFZZZ'),
};
const row = (jc: string) => parseListing(fx('listing-page1.html')).rows.find((r) => r.jc === jc)!;

test('topjobs: listing table → rows with codes, dates, town; total and next page', () => {
  const { rows, total, nextUrl } = parseListing(fx('listing-page1.html'));
  assert.deepEqual(rows.map((r) => r.jc), ['0001571430', '0001571429', '0001571428', '0001570753']);
  assert.equal(total, 4917);
  assert.match(nextUrl!, /^https:\/\/www\.topjobs\.lk\/applicant\/vacancybyfunctionalarea\.jsp\?FA=&jst=OPEN&.*pageNo=2$/);
  const r = rows[1];
  assert.deepEqual(
    { ...r },
    {
      jc: '0001571429', ac: 'DEFZZZ', ec: 'DEFZZZ', ref: '1571429',
      title: 'Deputy Center Director - Academic Affairs', company: 'Colombo Academy of Hospitality Management (Pvt) Ltd',
      summary: null, opening_date: '2026-11-15', closing_date: '2026-11-22', town: 'Malabe',
    },
  );
  assert.deepEqual([rows[0].ac, rows[0].ec, rows[0].town], ['0000000385', '0000000505', 'Colombo 3'], 'agency ad: agent and employer codes differ');
  assert.equal(rows[3].closing_date, '2026-11-26');
});

test('topjobs: external id is the job code from the URL', () => {
  assert.equal(externalIdFromUrl(U['1571429']), '0001571429');
  assert.equal(externalIdFromUrl('https://www.topjobs.lk/employer/JobAdvertismentServlet?rid=0&ac=DEFZZZ&jc=0001570753&ec=DEFZZZ&pg=applicant/vacancybyfunctionalarea.jsp'), '0001570753');
  assert.equal(externalIdFromUrl('https://www.topjobs.lk/index.jsp'), null);
});

test('topjobs: ad page → employer, place, closing date, labels, image, apply email', () => {
  const ad = parseAd(fx('ad-0001571429.html'));
  assert.equal(ad.jc, '0001571429');
  assert.equal(ad.title, 'Deputy Center Director - Academic Affairs');
  assert.equal(ad.company, 'Colombo Academy of Hospitality Management (Pvt) Ltd');
  assert.equal(ad.location, 'Malabe');
  assert.equal(ad.closing_date, '2026-11-22');
  assert.deepEqual(ad.labels, ['Full Time', 'Permanent', 'Onsite']);
  assert.deepEqual(ad.images, ['https://www.topjobs.lk/logo/DEFZZZ/4578cLANKAA.png']);
  assert.equal(ad.email, 'jobs4@example.lk');
  assert.equal(ad.foreign, false);

  const agency = parseAd(fx('ad-0001571430-no-email.html'));
  assert.equal(agency.email, null);
  assert.deepEqual(agency.images, ['https://www.topjobs.lk/logo/0000000385/1159cExecutive%20Secretary%20%20Executive%20PAo1.jpg']);

  const foreign = parseAd(fx('ad-0001571409-foreign.html'));
  assert.equal(foreign.foreign, true);
  assert.equal(foreign.location, 'All island, Indonesia');
});

test('topjobs: an image ad → is_image_ad, absolute image link in the description, email apply', () => {
  const j = mapJob(row('0001571429'), parseAd(fx('ad-0001571429.html')), { scrapedAt: SCRAPED })!;
  assert.equal(j.title, 'Deputy Center Director - Academic Affairs');
  assert.equal(j.company, 'Colombo Academy of Hospitality Management (Pvt) Ltd');
  assert.equal(j.location, 'Malabe');
  assert.equal(j.closing_date, '2026-11-22');
  assert.equal(j.posted_at, '2026-11-15');
  assert.equal(j.is_image_ad, true);
  assert.equal(j.description, '<p>Advert image: <a href="https://www.topjobs.lk/logo/DEFZZZ/4578cLANKAA.png">https://www.topjobs.lk/logo/DEFZZZ/4578cLANKAA.png</a></p>');
  assert.equal(j.apply_method, 'email');
  assert.equal(j.apply_email, 'jobs4@example.lk');
  assert.equal(j.apply_url, null);
  assert.equal(j.employment_type, 'Full Time, Permanent');
  assert.equal(j.remote, false);
  assert.equal(j.country_code, 'LK');
  assert.equal(j.external_id, '0001571429');
  assert.equal(j.source_url, U['1571429']);

  const portal = mapJob(row('0001571430'), parseAd(fx('ad-0001571430-no-email.html')), { scrapedAt: SCRAPED })!;
  assert.equal(portal.apply_method, 'portal');
  assert.equal(portal.apply_url, U['1571430']);
  assert.match(portal.apply_instructions!, /topjobs account/);
});

test('topjobs: a text ad keeps its markup; a foreign ad is not LK and keeps the country', () => {
  const text = '<p>We are looking for an Accounts Executive with AAT and two years of experience in a manufacturing company. Send your CV to the address below.</p>';
  const html = fx('ad-0001571429.html').replace(/<div id="remark"([^>]*)>[\s\S]*?<\/div>/, `<div id="remark"$1>${text}</div>`);
  const j = mapJob(row('0001571429'), parseAd(html), { scrapedAt: SCRAPED })!;
  assert.equal(j.is_image_ad, false);
  assert.equal(j.description, text);

  const r: ListingRow = { ...row('0001571430'), jc: '0001571409', town: 'All island' };
  const f = mapJob(r, parseAd(fx('ad-0001571409-foreign.html')), { scrapedAt: SCRAPED })!;
  assert.equal(f.country_code, null);
  assert.equal(f.location, 'All island, Indonesia');
});

test('topjobs scan: listing, skip seen, details in order, defer failed and error pages, follow next page', async () => {
  const ctx = fixtureContext({
    source: { id: 'topjobs', tiers: ['T1', 'T2', 'T3', 'T5'], options: { max_pages: 2 } },
    pages: {
      [LISTING_URL]: fx('listing-page1.html'),
      [U['1571430']]: fx('ad-0001571430-no-email.html'),
      [U['1571429']]: fx('ad-0001571429.html'),
      [U['1571428']]: fx('error-601.html'),
    },
    seen: ['0001570753'],
  });
  const r = await adapter.scan(ctx);
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['0001571430', '0001571429']);
  assert.equal(r.listed, 4);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.deferred, ['0001571428'], 'the site error page is deferred, not stored');
  const urls = ctx.calls.pages.map((p) => p.url);
  assert.equal(urls[0], LISTING_URL);
  assert.match(urls[1], /pageNo=2$/, 'page 2 follows the page’s own next link');
  assert.deepEqual(urls.slice(2), [U['1571430'], U['1571429'], U['1571428']]);
  assert.equal(ctx.calls.pages[0].req?.waitFor, 'tr[id^="tr"]');
  assert.equal(ctx.calls.pages[2].req?.waitFor, '#position');
  assert.equal(ctx.calls.pages[2].req?.kind, 'detail');
  assert.match(ctx.logs.join('\n'), /2 image ads/);
});

test('topjobs scan: a failed detail fetch is deferred; max_details caps details', async () => {
  const ctx = fixtureContext({
    source: { id: 'topjobs', max_details: 2, options: { max_pages: 1 } },
    pages: { [LISTING_URL]: fx('listing-page1.html'), [U['1571430']]: { ok: false, status: null, block: { reason: 'challenge', detail: 'Cloudflare' } } },
  });
  const r = await adapter.scan(ctx);
  assert.deepEqual(r.deferred, ['0001571430', '0001571429']);
  assert.equal(ctx.calls.pages.length, 3);
});

test('topjobs scan: `since` stops at older postings without fetching them', async () => {
  const ctx = fixtureContext({ source: 'topjobs', since: new Date('2026-11-16T00:00:00Z'), pages: { [LISTING_URL]: fx('listing-page1.html') } });
  const r = await adapter.scan(ctx);
  assert.equal(r.jobs.length, 0);
  assert.equal(ctx.calls.pages.length, 1);
});

test('topjobs scan: an unreachable or redesigned listing is a whole-source failure', async () => {
  await assert.rejects(adapter.scan(fixtureContext({ source: 'topjobs' })), /topjobs: the vacancy list could not be loaded/);
  const drift = fixtureContext({ source: 'topjobs', pages: { [LISTING_URL]: `<html>${'<div>new design</div>'.repeat(2000)}</html>` } });
  await assert.rejects(adapter.scan(drift), /drift/);
  // expect() accepts the real listing and both ad pages and the site's error page (a dead link is an answer)
  const ok = fixtureContext({ source: 'topjobs', pages: { [LISTING_URL]: fx('listing-page1.html') } });
  await adapter.scan(ok);
  const listExpect = ok.calls.pages[0].req!.expect!;
  const adExpect = ok.calls.pages.find((p) => p.req?.kind === 'detail')!.req!.expect!;
  assert.equal(listExpect(fx('listing-page1.html')), true);
  assert.equal(adExpect(fx('ad-0001571429.html')), true);
  assert.equal(adExpect(fx('error-601.html')), true);
  assert.equal(adExpect('<html>login</html>'), false);
});

test('topjobs recheck: a passed closing date → closed; open ad → alive; error page, failure, stale → unknown', async () => {
  const job = { source_url: U['1571429'], external_id: '0001571429' };
  const open = fixtureContext({ source: 'topjobs', pages: { [U['1571429']]: fx('ad-0001571429.html') } });
  assert.equal(await adapter.recheck(job, open), 'alive');
  assert.equal(open.calls.pages[0].req?.noCache, true);
  const late = fixtureContext({ source: 'topjobs', now: new Date('2026-11-23T00:00:00Z'), pages: { [U['1571429']]: fx('ad-0001571429.html') } });
  assert.equal(await adapter.recheck(job, late), 'closed');
  const error = fixtureContext({ source: 'topjobs', pages: { [U['1571429']]: fx('error-601.html') } });
  assert.equal(await adapter.recheck(job, error), 'unknown', 'not verified that 601 means removed');
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'topjobs' })), 'unknown', 'topjobs does not hard-404');
  const stale = fixtureContext({ source: 'topjobs', now: new Date('2026-11-23T00:00:00Z'), pages: { [U['1571429']]: { html: fx('ad-0001571429.html'), staleAgeS: 3600, tier: 'T5' } } });
  assert.equal(await adapter.recheck(job, stale), 'unknown');
  assert.equal(await adapter.recheck({ source_url: 'https://example.lk/x', external_id: '0001571429' }, open), 'unknown');
});
