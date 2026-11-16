import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { SljError } from '../src/errors.ts';
import { loadAdapter, sourceConfigs } from '../src/sources/load.ts';
import { mapInOrder } from '../src/sources/util.ts';
import { ROOT } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('mapInOrder returns results in input order whatever finishes first, with bounded concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const delays = [40, 5, 25, 1, 15, 30, 2];
  const out = await mapInOrder(
    delays,
    async (ms, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight--;
      return `${i}:${ms}`;
    },
    3,
  );
  assert.deepEqual(out, delays.map((ms, i) => `${i}:${ms}`));
  assert.equal(peak, 3);
});

test('mapInOrder: empty input, one worker runs sequentially, a rejection propagates', async () => {
  assert.deepEqual(await mapInOrder([], async (x) => x, 4), []);
  const order: number[] = [];
  await mapInOrder([3, 1, 2], async (x) => {
    order.push(x);
    await sleep(x);
  }, 1);
  assert.deepEqual(order, [3, 1, 2]);
  assert.deepEqual(await mapInOrder([1, 2], async (x) => x * 2, 0), [2, 4], 'workers < 1 means 1');
  await assert.rejects(mapInOrder([1, 2, 3], async (x) => {
    if (x === 2) throw new Error('boom');
    return x;
  }, 2), /boom/);
});

test('sourceConfigs lists config/sources.yml in precedence order as SourceConfig', () => {
  const list = sourceConfigs(loadConfig(path.join(ROOT, 'config'), {}));
  const ids = list.map((s) => s.id);
  const byId = new Map(list.map((s) => [s.id, s]));
  // Precedence (PRD §7.2): every ATS family first, then XpressJobs, then the other boards, government last.
  const firstNonAts = list.findIndex((s) => s.kind !== 'ats');
  assert.ok(list.slice(0, firstNonAts).every((s) => s.kind === 'ats'), 'ATS families first');
  assert.ok(list.slice(firstNonAts).every((s) => s.kind !== 'ats'), 'no ATS after the boards');
  assert.equal(ids[firstNonAts], 'xpressjobs', 'XpressJobs right after the ATS families');
  assert.equal(list.at(-1)!.kind, 'government');
  for (const id of ['workday', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'ikman', 'topjobs', 'hotjobs', 'jobeka', 'rooster',
    'itpro', 'careers360', 'jobber', 'jobsnet', 'dreamjobs', 'governmentjobs']) assert.ok(byId.has(id), id);
  assert.equal(new Set(ids).size, ids.length);

  // Verified tiers (I1): topjobs works over plain HTTP, browser tiers are its fallback.
  const topjobs = byId.get('topjobs')!;
  assert.deepEqual(topjobs.tiers, ['T1', 'T2', 'T3', 'T5']);
  assert.equal(topjobs.slow, false);
  assert.deepEqual(byId.get('xpressjobs')!.tiers, ['T0']);
  for (const s of list) {
    assert.ok(s.max_details > 0 && s.max_details <= 5000, s.id);
    // PRD §7.2 pacing: 1.5 s for HTML sites, 0.5 s for JSON APIs (the ATS families, and XpressJobs,
    // whose detail pages are its own JSON API).
    assert.equal(s.delay_ms, s.kind === 'ats' || s.id === 'xpressjobs' ? 500 : 1500, s.id);
    if (s.kind === 'ats') {
      assert.equal(s.slow, true, s.id);
      assert.deepEqual(s.tiers, ['T0'], s.id);
    }
    assert.ok(!('priority' in s) && !('notes' in s), 'only SourceConfig fields');
  }
  // Dead sites and Ashby (no Sri Lanka board yet) stay off.
  for (const id of ['careers360', 'jobber', 'jobsnet', 'ashby']) assert.equal(byId.get(id)!.enabled, false, id);
  // The normal (not slow) scan is the P1 boards.
  assert.deepEqual(list.filter((s) => s.enabled && !s.slow).map((s) => s.id), ['xpressjobs', 'ikman', 'topjobs', 'hotjobs', 'jobeka', 'rooster']);
});

test('loadAdapter: missing folder is NOT_FOUND, bad id is INVALID_INPUT, a valid adapter loads', async () => {
  await assert.rejects(loadAdapter('no_such_source'), (e: SljError) => e.code === 'NOT_FOUND' && /src\/sources\/no_such_source\/index\.ts/.test(e.message));
  await assert.rejects(loadAdapter('../config'), (e: SljError) => e.code === 'INVALID_INPUT');

  const dir = path.join(ROOT, 'src/sources/zz_f0_loadtest');
  const bad = path.join(ROOT, 'src/sources/zz_f0_badtest');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.ts'),
      "export default { id: 'zz_f0_loadtest', scan: async () => ({ jobs: [], listed: 0, skippedSeen: 0, deferred: [] }), recheck: async () => 'unknown' };\n",
    );
    const a = await loadAdapter('zz_f0_loadtest');
    assert.equal(a.id, 'zz_f0_loadtest');
    assert.equal(await a.recheck({ source_url: 'x', external_id: '1' }, {} as any), 'unknown');

    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'index.ts'), "export default { id: 'zz_f0_badtest' };\n");
    await assert.rejects(loadAdapter('zz_f0_badtest'), /must default-export/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
  }
});
