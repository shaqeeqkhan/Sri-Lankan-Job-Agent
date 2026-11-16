import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalUrl, inferApplyMethod, jobHash, normCompany, parseDate } from '../src/jobs/normalize.ts';

test('parseDate reads Sri Lankan day-first numeric dates', () => {
  assert.equal(parseDate('05/11/2026'), '2026-11-05');
  assert.equal(parseDate('5.11.2026'), '2026-11-05');
  assert.equal(parseDate('05-11-26'), '2026-11-05');
  assert.equal(parseDate('2026-11-05'), '2026-11-05');
  assert.equal(parseDate('2026.11.05'), '2026-11-05');
});

test('parseDate reads written dates', () => {
  assert.equal(parseDate('5th November 2026'), '2026-11-05');
  assert.equal(parseDate('21st of October, 2026'), '2026-10-21');
  assert.equal(parseDate('November 5, 2026'), '2026-11-05');
  assert.equal(parseDate('Sept 30 2026'), '2026-09-30');
  assert.equal(parseDate('02 Nov 2026 (Monday)'), '2026-11-02');
});

test('parseDate rejects impossible and non-dates', () => {
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('soon'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('5 Monday 2026'), null);
});

test('normCompany strips Sri Lankan company suffixes', () => {
  const want = 'lanka biscuit works';
  for (const name of ['Lanka Biscuit Works (Pvt) Ltd', 'LANKA BISCUIT WORKS PVT LTD', 'Lanka Biscuit Works (Private) Limited', 'Lanka Biscuit Works PLC']) {
    assert.equal(normCompany(name), want, name);
  }
});

test('canonicalUrl drops tracking params, fragments, www and trailing slash', () => {
  assert.equal(
    canonicalUrl('https://WWW.xpress.jobs/jobs/1/?utm_source=fb&fbclid=abc&b=2&a=1#apply'),
    'https://xpress.jobs/jobs/1?a=1&b=2',
  );
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl('not a url'), null);
});

test('jobHash matches the same role across sources, and uses the contact when the company is unknown', () => {
  const a = jobHash({ title: 'Assistant Accountant', company: 'Lanka Biscuit Works (Pvt) Ltd' });
  const b = jobHash({ title: 'ASSISTANT ACCOUNTANT', company: 'Lanka Biscuit Works PLC' });
  assert.equal(a, b);
  const c = jobHash({ title: 'Driver', company: null, apply_phone: '0771234567' });
  const d = jobHash({ title: 'Driver', company: null, apply_phone: '0719999999' });
  assert.notEqual(c, d);
});

test('inferApplyMethod prefers an explicit method, then email', () => {
  assert.equal(inferApplyMethod({ apply_method: 'post', apply_email: 'a@b.lk' }, false), 'post');
  assert.equal(inferApplyMethod({ apply_email: 'a@b.lk', apply_url: 'https://x' }, true), 'email');
  assert.equal(inferApplyMethod({ apply_url: 'https://x' }, true), 'portal');
  assert.equal(inferApplyMethod({ apply_url: 'https://x' }, false), 'form');
  assert.equal(inferApplyMethod({ apply_phone: '0771234567' }, false), 'phone');
  assert.equal(inferApplyMethod({}, false), 'unknown');
});

// ---------------------------------------------------------------- v2: rule 11 dates, salary, rule 9

import { fillNulls, parseSalary } from '../src/jobs/normalize.ts';

test('rule 11: an ambiguous date with no year is null; a written one needs `now` and must be near it', () => {
  const now = new Date('2026-11-15T04:00:00Z');
  assert.equal(parseDate('03/04', { now }), null);
  assert.equal(parseDate('03/04'), null);
  assert.equal(parseDate('5th November'), null, 'no year and no now');
  assert.equal(parseDate('5th November', { now }), '2026-11-05');
  assert.equal(parseDate('30 Nov', { now }), '2026-11-30');
  assert.equal(parseDate('January 5', { now }), '2027-01-05');
  assert.equal(parseDate('10 Oct', { now }), null, 'over a month ago and 11 months ahead: not a safe reading');
  assert.equal(parseDate('03/04/2026', { now }), '2026-04-03', 'day-first with a year is the local convention');
  assert.equal(parseDate('11/25/2026'), null, 'month-first US dates are not guessed');
});

test('salary only when currency and figure are unambiguous', () => {
  const t = (s: string) => parseSalary(s)?.text ?? null;
  assert.equal(t('Rs. 85,000/-'), 'LKR 85,000');
  assert.equal(t('LKR 90k–110k'), 'LKR 90,000–110,000');
  assert.equal(t('Salary: Rs 75,000 - 95,000 per month'), 'LKR 75,000–95,000 per month');
  assert.equal(t('Rs. 85,000 to Rs. 95,000/-'), 'LKR 85,000–95,000');
  assert.equal(t('LKR 1.2 Mn per year'), 'LKR 1,200,000 per year');
  assert.equal(t('USD 1,200 per month'), 'USD 1,200 per month');
  assert.deepEqual(parseSalary('LKR 90k–110k'), { currency: 'LKR', min: 90000, max: 110000, period: null, text: 'LKR 90,000–110,000' });
  for (const s of ['Negotiable', 'Attractive salary', '85,000', 'Call 0771234567', 'Rs. 500', 'Rs. 95,000 - 85,000', 'Rs. 85,000/- or Rs. 90,000/-', '']) {
    assert.equal(parseSalary(s), null, s);
  }
});

test('rule 9: fillNulls never overwrites a structured value', () => {
  const out = fillNulls(
    { closing_date: '2026-11-30', salary_text: null as string | null, location: '' , company: 'A' },
    { closing_date: '2026-12-01', salary_text: 'LKR 85,000', location: 'Kandy', company: null as unknown as string },
  );
  assert.deepEqual(out, { closing_date: '2026-11-30', salary_text: 'LKR 85,000', location: 'Kandy', company: 'A' });
});
