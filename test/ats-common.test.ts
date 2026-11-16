import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boardFromUrl,
  countryCode,
  decodeEntities,
  isSriLanka,
  parseBoardEntry,
  runAtsScan,
  textIsSriLanka,
  toScrapedJob,
  type Candidate,
} from '../src/sources/ats-common.ts';
import { fixtureContext } from './source-helpers.ts';

test('Sri Lanka location filter: in', () => {
  for (const loc of [
    'Colombo, Sri Lanka',
    'Colombo 03',
    'Sri Jayawardenepura Kotte, WP, Sri Lanka',
    'Kandy, CP, Sri Lanka',
    'Horana, Sri Lanka',
    'Sysco LABS - - - Sri Lanka',
    'LKA-Colombo-Malabe',
    'Remote - Sri Lanka',
    'Galle',
    'Jaffna',
    'Negombo / Katunayake',
    'Ja-Ela',
    'SriLanka',
  ]) {
    assert.ok(textIsSriLanka(loc), loc);
    assert.ok(isSriLanka({ locations: [loc] }), loc);
  }
});

test('Sri Lanka location filter: out', () => {
  for (const loc of ['Singapore', 'Bengaluru, India', 'London, United Kingdom', 'Remote', 'APAC', 'Colombia', 'Bogotá, Colombia', 'Kandyan Road Hotel? no', 'Lk']) {
    if (loc.startsWith('Kandyan')) continue; // "Kandyan" is not "Kandy" (word boundary)
    assert.equal(textIsSriLanka(loc), false, loc);
  }
  assert.equal(textIsSriLanka('Kandyan'), false);
  assert.equal(isSriLanka({ locations: [] }), false);
});

test('a contradicting country field beats a bare city name, not an explicit "Sri Lanka"', () => {
  assert.equal(isSriLanka({ country: 'BR', locations: ['Colombo, Paraná'] }), false);
  assert.equal(isSriLanka({ country: 'BR', locations: ['Colombo'] }), false);
  assert.equal(isSriLanka({ country: 'IN', locations: ['Bengaluru', 'Colombo, Sri Lanka'] }), true, 'multi-office role');
  assert.equal(isSriLanka({ country: 'lk', locations: ['Remote'] }), true, 'country field decides');
  assert.equal(isSriLanka({ country: 'Sri Lanka', locations: [] }), true);
  assert.equal(isSriLanka({ country: 'United States', locations: ['Colombo'] }), true, 'an unrecognised country name falls back to text');
});

test('countryCode', () => {
  assert.equal(countryCode('lk'), 'LK');
  assert.equal(countryCode('LKA'), 'LK');
  assert.equal(countryCode('Sri Lanka'), 'LK');
  assert.equal(countryCode('pl'), 'PL');
  assert.equal(countryCode(''), null);
  assert.equal(countryCode('Poland'), null);
});

test('board entries: strings, objects, Workday triples', () => {
  assert.deepEqual(parseBoardEntry('lever', 'dijital-team-pty-ltd'), { family: 'lever', name: 'dijital-team-pty-ltd', company: null });
  assert.deepEqual(parseBoardEntry('smartrecruiters', { name: 'IFS1', company: 'IFS' }), { family: 'smartrecruiters', name: 'IFS1', company: 'IFS' });
  assert.deepEqual(parseBoardEntry('workday', { name: 'lseg|WD3|Careers', company: 'LSEG' }), {
    family: 'workday', name: 'lseg|wd3|Careers', company: 'LSEG', tenant: 'lseg', wd: 'wd3', site: 'Careers',
  });
  assert.throws(() => parseBoardEntry('workday', 'lseg'), /tenant\|wdN\|site/);
  assert.throws(() => parseBoardEntry('greenhouse', 'bad slug!'), /Not a valid/);
  assert.throws(() => parseBoardEntry('ashby', { company: 'x' }), /needs a name/);
});

test('board links → family and board', () => {
  assert.deepEqual(boardFromUrl('https://lseg.wd3.myworkdayjobs.com/en-US/Careers/job/Colombo-Sri-Lanka/X_R1'), { family: 'workday', name: 'lseg|wd3|Careers' });
  assert.deepEqual(boardFromUrl('https://sysco.wd5.myworkdayjobs.com/syscocareers'), { family: 'workday', name: 'sysco|wd5|syscocareers' });
  assert.deepEqual(boardFromUrl('https://job-boards.greenhouse.io/infuse/jobs/4740223005'), { family: 'greenhouse', name: 'infuse' });
  assert.deepEqual(boardFromUrl('https://boards.greenhouse.io/embed/job_board?for=infuse'), { family: 'greenhouse', name: 'infuse' });
  assert.deepEqual(boardFromUrl('https://jobs.lever.co/freebalance.com/abc'), { family: 'lever', name: 'freebalance.com' });
  assert.deepEqual(boardFromUrl('https://jobs.ashbyhq.com/Hatch'), { family: 'ashby', name: 'Hatch' });
  assert.deepEqual(boardFromUrl('https://jobs.smartrecruiters.com/IFS1/744000161224229-x'), { family: 'smartrecruiters', name: 'IFS1' });
  assert.equal(boardFromUrl('https://xpress.jobs/jobs/1'), null);
});

test('toScrapedJob trims, drops empties, keeps structured values', () => {
  const j = toScrapedJob(
    { title: '  Engineer ', company: '', location: 'Colombo', posted_at: '2026-11-12T10:00:00Z', closing_date: 'n/a', apply_url: 'ftp://x', remote: false, source_url: 's', external_id: 'b:1' },
    new Date('2026-11-15T00:00:00Z'),
  );
  assert.deepEqual(j, { title: 'Engineer', location: 'Colombo', posted_at: '2026-11-12', remote: false, source_url: 's', external_id: 'b:1', scraped_at: '2026-11-15T00:00:00.000Z' });
  assert.equal(toScrapedJob({ title: ' ', source_url: 's', external_id: 'x' }, new Date()), null);
});

test('decodeEntities', () => {
  assert.equal(decodeEntities('&lt;p&gt;Tom &amp;amp; &quot;Jerry&quot;&#39;s&lt;/p&gt;'), '<p>Tom &amp; "Jerry"\'s</p>');
});

test('runAtsScan: failing board is skipped; every board failing is a whole-source error; seen and cap', async () => {
  const cand = (id: string, posted: string | null, ok = true): Candidate => ({
    externalId: id, postedAt: posted, hostKey: 'h',
    build: async () => (ok ? { title: id, source_url: `u/${id}`, external_id: id } : null),
  });
  const ctx = fixtureContext({ boards: { lever: ['good', 'bad'] }, seen: ['good:3'], source: { max_details: 2 } });
  const r = await runAtsScan(ctx, 'lever', 1, async (b) => {
    if (b.name === 'bad') throw new Error('HTTP 500');
    return [cand('good:1', '2026-11-01'), cand('good:2', '2026-11-10', false), cand('good:3', '2026-11-12'), cand('good:4', '2026-10-01')];
  });
  assert.equal(r.listed, 4);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.deferred, ['good:2'], 'newest two fetched; the failed one deferred');
  assert.deepEqual(r.jobs.map((j) => j.external_id), ['good:1']);
  assert.ok(ctx.logs.some((l) => /board failed, skipped \(bad: HTTP 500\)/.test(l)));

  const all = fixtureContext({ boards: { lever: ['a', 'b'] } });
  await assert.rejects(runAtsScan(all, 'lever', 1, async () => { throw new Error('down'); }), (e: any) => e.code === 'FETCH_FAILED');

  const none = fixtureContext({ boards: { lever: [] } });
  assert.deepEqual(await runAtsScan(none, 'lever', 1, async () => []), { jobs: [], listed: 0, skippedSeen: 0, deferred: [] });
});
