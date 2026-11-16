import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../src/sources/ikman/index.ts';
import { adUrl, externalIdFromUrl, initialData, LISTING_URL, mapAd, parseListing } from '../src/sources/ikman/parse.ts';
import { fixtureContext, parseJsonLd, readFixture } from './source-helpers.ts';

const fx = (name: string) => readFixture('ikman', name);
const SCRAPED = '2026-11-15T04:00:00.000Z';
const PAGE2 = `${LISTING_URL}?page=2`;
const STORES = 'stores-keeper-nawala-colombo-1';
const ACCOUNTANT = 'senior-accountant-jaffna-1';
const OFFICE = 'office-assistant-job-vacancy-kiribathgoda-malefemale-urgent-gampaha';

/** A minimal ad page with the given ad object (for cases the real fixtures do not cover). */
const adPage = (ad: Record<string, unknown>) => `<html><script>window.initialData = ${JSON.stringify({ adDetail: { type: 'Success', data: { ad } } })}</script></html>`;

test('ikman: listing page → ads (regular then top ads), total, structured listing fields', () => {
  const { ads, total, ok } = parseListing(fx('listing-page1.html'));
  assert.equal(ok, true);
  assert.equal(total, 10288);
  assert.deepEqual(ads.map((a) => a.slug), [
    'kitchen-asssitant-colombo',
    'supervisor-colombo-1038',
    ACCOUNTANT,
    STORES,
    OFFICE,
    'tea-servant-female-colombo',
  ]);
  const stores = ads.find((a) => a.slug === STORES)!;
  assert.equal(stores.title, 'Stores Keeper - Nawala');
  assert.equal(stores.salary, 'Rs 58,000 - 60,000');
  assert.equal(stores.deadline, '2026-12-24');
  assert.equal(stores.company, 'Master of sound');
  assert.equal(ads[0].featured, true);
  assert.equal(parseListing('<html>no data</html>').ok, false);
});

test('ikman: external id is the ad slug from the URL, any language', () => {
  assert.equal(externalIdFromUrl('https://ikman.lk/en/ad/stores-keeper-nawala-colombo-1'), STORES);
  assert.equal(externalIdFromUrl('https://ikman.lk/si/ad/Stores-Keeper-Nawala-Colombo-1?ref=x'), STORES);
  assert.equal(externalIdFromUrl('http://ikman.lk/ad/cashier-gampaha-1018'), 'cashier-gampaha-1018');
  assert.equal(externalIdFromUrl('https://ikman.lk/en/ads/sri-lanka/jobs'), null);
});

test('ikman: initialData is read from the page even when the object is followed by more script', () => {
  const d = initialData('<script>window.initialData = {"a":{"b":"}{"}} ;\nwindow.x = 1;</script>');
  assert.deepEqual(d, { a: { b: '}{' } });
  assert.equal(initialData('<script>window.initialData = {"a":</script>'), null);
});

test('ikman: ad page → ScrapedJob (phone apply)', () => {
  const html = fx(`ad-${STORES}.html`);
  const j = mapAd(html, parseJsonLd(html), { slug: STORES, scrapedAt: SCRAPED })!;
  assert.equal(j.title, 'Stores Keeper - Nawala');
  assert.equal(j.company, 'Master of sound');
  assert.equal(j.location, 'Nawala, Colombo');
  assert.equal(j.category, 'Stores and Warehouse');
  assert.equal(j.salary_text, 'Rs 58,000 - 60,000 per month');
  assert.equal(j.closing_date, '2026-12-24');
  assert.equal(j.posted_at, '2026-11-15T01:58:37+05:30');
  assert.equal(j.employment_type, 'Full Time');
  assert.equal(j.apply_method, 'phone');
  assert.equal(j.apply_phone, '0760000006');
  assert.equal(j.apply_url, null);
  assert.equal(j.is_image_ad, false);
  assert.equal(j.country_code, 'LK');
  assert.equal(j.remote, null);
  assert.equal(j.source_url, `https://ikman.lk/en/ad/${STORES}`);
  assert.equal(j.external_id, STORES);
  assert.match(j.description!, /ස්ටොර්ස් කිපර්වරුන්/);
  assert.match(j.description!, /Required education: Skilled Apprentice/);
  assert.match(j.description!, /Required work experience: 1 year$/m);
});

test('ikman: ad page → ScrapedJob (apply on ikman, CV required)', () => {
  const html = fx(`ad-${ACCOUNTANT}.html`);
  const j = mapAd(html, parseJsonLd(html), { slug: ACCOUNTANT, scrapedAt: SCRAPED })!;
  assert.equal(j.company, 'Easy accounting company (PVT) ltd');
  assert.equal(j.location, 'Jaffna City, Jaffna');
  assert.equal(j.salary_text, 'Rs 200,000 - 300,000 per month');
  assert.equal(j.closing_date, '2026-12-15');
  assert.equal(j.apply_method, 'portal');
  assert.equal(j.apply_url, `https://ikman.lk/en/ad/${ACCOUNTANT}`);
  assert.match(j.apply_instructions!, /CV is required/);
  assert.match(j.description!, /Company website: http:\/\/www\.easya\.no/);
});

test('ikman: JSON-LD fills what the page data leaves out; an image-only ad goes to the vision path', () => {
  const ld = [{
    '@type': 'JobPosting', title: 'Driver', hiringOrganization: { name: 'ABC Transport' }, validThrough: '2026-12-01',
    employmentType: 'FULL_TIME', baseSalary: { currency: 'LKR', value: { minValue: '70000', maxValue: '70000', unitText: 'MONTH' } },
  }];
  const html = adPage({
    title: 'Driver - Work From Home', description: 'Call us', status: 'published', properties: [],
    location: { name: 'Kandy' }, images: { meta: [{ src: 'https://i.ikman-st.com/u/driver/abc' }] }, job: { apply_via: { email: 'hr@abc.lk' } },
  });
  const j = mapAd(html, ld, { slug: 'driver-kandy', scrapedAt: SCRAPED })!;
  assert.equal(j.company, 'ABC Transport');
  assert.equal(j.salary_text, 'LKR 70,000 per month');
  assert.equal(j.closing_date, '2026-12-01');
  assert.equal(j.employment_type, 'FULL_TIME');
  assert.equal(j.apply_method, 'email');
  assert.equal(j.apply_email, 'hr@abc.lk');
  assert.equal(j.is_image_ad, true);
  assert.match(j.description!, /Advert image: https:\/\/i\.ikman-st\.com\/u\/driver\/abc/);
  assert.equal(j.remote, true);
  assert.equal(mapAd('<html></html>', ld, { slug: 'x', scrapedAt: SCRAPED }), null);
});

test('ikman scan: skip seen, details in listing order, defer a failed detail, drop a removed ad, cap at max_details', async () => {
  const ctx = fixtureContext({
    source: { id: 'ikman', max_details: 4, options: { max_pages: 2 } },
    pages: {
      [LISTING_URL]: fx('listing-page1.html'),
      [adUrl(ACCOUNTANT)]: fx(`ad-${ACCOUNTANT}.html`),
      [adUrl(STORES)]: fx(`ad-${STORES}.html`),
      [adUrl(OFFICE)]: { ok: false, status: null, block: { reason: 'timeout', detail: 'timed out' } },
      [adUrl('supervisor-colombo-1038')]: { ok: false, status: 410, block: { reason: 'http', detail: 'HTTP 410' } },
    },
    seen: ['kitchen-asssitant-colombo'],
  });
  const r = await adapter.scan(ctx);
  assert.deepEqual(r.jobs.map((j) => j.external_id), [ACCOUNTANT, STORES]);
  assert.equal(r.listed, 6);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.deferred, [OFFICE]);
  assert.deepEqual(ctx.calls.pages.map((p) => p.url), [
    LISTING_URL,
    adUrl('supervisor-colombo-1038'),
    adUrl(ACCOUNTANT),
    adUrl(STORES),
    adUrl(OFFICE),
  ], 'enough new ads on page 1, so page 2 is not fetched; 4 details at most');
  assert.equal(ctx.calls.pages[0].req?.kind, 'listing');
  assert.equal(ctx.calls.pages[1].req?.kind, 'detail');
  assert.ok(r.jobs.every((j) => j.scraped_at === '2026-11-15T04:00:00.000Z'));
});

test('ikman scan: pages on while there are new ads, stops at a fully seen page', async () => {
  const page1 = parseListing(fx('listing-page1.html')).ads.map((a) => a.slug);
  const fresh = fixtureContext({ source: { id: 'ikman', options: { max_pages: 3 } }, pages: { [LISTING_URL]: fx('listing-page1.html'), [PAGE2]: fx('listing-page2.html') } });
  const r = await adapter.scan(fresh);
  const listings = fresh.calls.pages.filter((p) => p.req?.kind === 'listing').map((p) => p.url);
  assert.deepEqual(listings, [LISTING_URL, PAGE2, `${LISTING_URL}?page=3`], 'page 3 is missing: logged, paging stops');
  assert.equal(r.listed, 10);
  assert.match(fresh.logs.join('\n'), /listing page 3 failed/);

  const caughtUp = fixtureContext({ source: { id: 'ikman', options: { max_pages: 3 } }, pages: { [LISTING_URL]: fx('listing-page1.html') }, seen: page1 });
  const c = await adapter.scan(caughtUp);
  assert.equal(caughtUp.calls.pages.length, 1);
  assert.equal(c.skippedSeen, 6);
  assert.deepEqual(c.jobs, []);
});

test('ikman scan: a blocked or redesigned first listing page is a whole-source failure', async () => {
  const drift = fixtureContext({ source: 'ikman', pages: { [LISTING_URL]: `<html>${'x'.repeat(30_000)}</html>` } });
  await assert.rejects(adapter.scan(drift), /ikman: the jobs listing could not be loaded \(drift/);
  const blocked = fixtureContext({ source: 'ikman', pages: { [LISTING_URL]: { ok: false, status: 403, block: { reason: 'http', detail: 'HTTP 403' } } } });
  await assert.rejects(adapter.scan(blocked), /HTTP 403/);
  assert.equal(drift.calls.pages[0].req?.expect?.(fx('listing-page1.html')), true);
});

test('ikman recheck: published → alive; 404/410, not published or past deadline → closed; ambiguous → unknown', async () => {
  const job = { source_url: adUrl(STORES), external_id: STORES };
  const alive = fixtureContext({ source: 'ikman', pages: { [adUrl(STORES)]: fx(`ad-${STORES}.html`) } });
  assert.equal(await adapter.recheck(job, alive), 'alive');
  assert.equal(alive.calls.pages[0].req?.noCache, true);
  const late = fixtureContext({ source: 'ikman', now: new Date('2027-01-02T00:00:00Z'), pages: { [adUrl(STORES)]: fx(`ad-${STORES}.html`) } });
  assert.equal(await adapter.recheck(job, late), 'closed');
  assert.equal(await adapter.recheck(job, fixtureContext({ source: 'ikman' })), 'closed', 'no page: HTTP 404');
  const removed = fixtureContext({ source: 'ikman', pages: { [adUrl(STORES)]: { ok: false, status: 410, block: { reason: 'http', detail: 'HTTP 410' } } } });
  assert.equal(await adapter.recheck(job, removed), 'closed');
  const expired = fixtureContext({ source: 'ikman', pages: { [adUrl(STORES)]: adPage({ title: 'x', status: 'expired' }) } });
  assert.equal(await adapter.recheck(job, expired), 'closed');
  const blocked = fixtureContext({ source: 'ikman', pages: { [adUrl(STORES)]: { ok: false, status: 503, block: { reason: 'http', detail: 'HTTP 503' } } } });
  assert.equal(await adapter.recheck(job, blocked), 'unknown');
  const stale = fixtureContext({ source: 'ikman', pages: { [adUrl(STORES)]: { html: fx(`ad-${STORES}.html`), staleAgeS: 7200, tier: 'T5' } } });
  assert.equal(await adapter.recheck(job, stale), 'unknown');
});
