import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearbyDistricts, placeOf, requirementsExcerpt } from '../src/match/deps.ts';
import { derive } from '../src/match/score-store.ts';
import { DEFAULT_BANDS, renderStars, starsFromPoints } from '../src/match/stars.ts';
import { containsQuote, titleSimilarity } from '../src/match/text.ts';

test('star bands: 85+ five, 70-84 four, 55-69 three, 40-54 two, under 40 one', () => {
  const cases: [number, number][] = [[100, 5], [85, 5], [84, 4], [70, 4], [69, 3], [55, 3], [54, 2], [40, 2], [39, 1], [0, 1]];
  for (const [p, s] of cases) assert.equal(starsFromPoints(p, DEFAULT_BANDS), s, `${p} points`);
  assert.equal(starsFromPoints(60, { five: 90, four: 80, three: 60, two: 50 }), 3, 'bands come from settings');
});

test('renderStars', () => {
  assert.equal(renderStars(4), '★★★★☆');
  assert.equal(renderStars(1), '★☆☆☆☆');
  assert.equal(renderStars(5), '★★★★★');
});

const dims = (p: number) => ({ role_fit: Math.min(25, p), must_haves: Math.min(30, Math.max(0, p - 25)), seniority: Math.min(15, Math.max(0, p - 55)), education: Math.min(10, Math.max(0, p - 70)), location: Math.min(10, Math.max(0, p - 80)), domain: Math.min(10, Math.max(0, p - 90)) });

test('caps: missing mandatory caps at 2 stars; any scam signal caps at 1 star with capped_by scam', () => {
  const base = { requirements: [], scam_signals: [], missing_mandatory: [] };
  assert.deepEqual(derive({ ...base, dimensions: dims(90) }, DEFAULT_BANDS), { points: 90, raw_stars: 5, stars: 5, capped_by: null, missing_mandatory: [] });

  const mand = derive({ ...base, dimensions: dims(90), missing_mandatory: ['CIMA passed finalist'] }, DEFAULT_BANDS);
  assert.equal(mand.stars, 2);
  assert.equal(mand.capped_by, 'missing_mandatory');
  assert.equal(mand.points, 90, 'points are kept; only stars are capped');

  const fromReq = derive(
    { ...base, dimensions: dims(75), requirements: [{ text: 'Driving licence', jd_quote: 'valid driving licence', status: 'missing', mandatory: true }] },
    DEFAULT_BANDS,
  );
  assert.equal(fromReq.stars, 2);
  assert.deepEqual(fromReq.missing_mandatory, ['Driving licence']);

  const low = derive({ ...base, dimensions: dims(30), missing_mandatory: ['x'] }, DEFAULT_BANDS);
  assert.equal(low.stars, 1);
  assert.equal(low.capped_by, null, 'a cap that changes nothing is not reported');

  const scam = derive({ ...base, dimensions: dims(95), scam_signals: ['asks for a registration fee'], missing_mandatory: ['x'] }, DEFAULT_BANDS);
  assert.equal(scam.stars, 1);
  assert.equal(scam.capped_by, 'scam');
  assert.equal(derive({ ...base, dimensions: dims(10), scam_signals: ['fee'] }, DEFAULT_BANDS).capped_by, 'scam');
});

test('title similarity ignores seniority words and stems', () => {
  assert.equal(titleSimilarity('Senior Data Analyst', 'Data Analyst'), 1);
  assert.ok(titleSimilarity('Accounts Executive', 'Accountant') >= 0.5);
  assert.ok(titleSimilarity('Data Entry Operator', 'Data Analyst') < 0.5);
  assert.equal(titleSimilarity('Driver', 'Data Analyst'), 0);
});

test('jd_quote matching ignores case, whitespace, smart quotes and Markdown emphasis', () => {
  const ad = '**Requirements**\n- Minimum 2  years’ experience in\n  SQL – reporting';
  assert.ok(containsQuote(ad, "minimum 2 years' experience in SQL - reporting"));
  assert.ok(containsQuote(ad, 'Requirements'));
  assert.ok(!containsQuote(ad, '5 years experience in SQL'));
});

test('place and excerpt seams (src/jobs/places.ts, clean.ts) in match form', () => {
  assert.deepEqual(placeOf('Colombo 03'), { district: 'colombo', slug: 'colombo', remote: false });
  assert.equal(placeOf('Negombo').district, 'gampaha');
  assert.equal(placeOf('Nuwara Eliya').slug, 'nuwara-eliya');
  assert.equal(placeOf('Remote / Work from home').remote, true);
  assert.equal(placeOf('Somewhere').district, null);
  assert.ok(nearbyDistricts('colombo').includes('gampaha'));
  assert.ok(!nearbyDistricts('colombo').includes('kandy'));

  const long = `${'About us. '.repeat(300)}\n\nRequirements\n- SQL\n- Power BI\n${'Benefits and more. '.repeat(100)}`;
  const ex = requirementsExcerpt(long, 1500);
  assert.ok(ex.length <= 1500);
  assert.ok(ex.includes('Requirements\n- SQL'), 'starts near the requirements heading');
  assert.equal(requirementsExcerpt('Short ad', 1500), 'Short ad');
});
