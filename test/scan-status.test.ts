import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { HISTORY_KEEP, lowSources, readHistory, readStatus, recordScan, type ScanHistoryEntry, type SourceRunStats } from '../src/sources/status.ts';
import { makeCtx } from './helpers.ts';

function st(listed: number, failed = false): SourceRunStats {
  return {
    status: failed ? 'partial' : 'ok', failed, error: failed ? 'boom' : null, tier: 'T1', listed, jobs: listed, deferred: 0,
    http_status: null, challenge: false, human_solved: false, stale_age_s: null, duration_s: 1, finished_at: '2026-11-15T00:00:00Z',
  };
}
const run = (i: number, sources: Record<string, SourceRunStats>): ScanHistoryEntry => ({
  scan_id: `s${i}`, started_at: '2026-11-15T00:00:00Z', finished_at: '2026-11-15T00:01:00Z', result: 'ok', sources,
});

test('low source: 0 listed always; under 30% of its own 7-run median once 3 earlier runs exist', () => {
  const two = [run(1, { a: st(100) }), run(2, { a: st(100) })];
  assert.deepEqual(lowSources({ a: st(10) }, two), [], 'not judged with only 2 earlier runs');
  assert.deepEqual(lowSources({ a: st(0) }, []), ['a'], 'nothing listed is broken, not a quiet day');
  const three = [...two, run(3, { a: st(100) })];
  assert.deepEqual(lowSources({ a: st(29) }, three), ['a']);
  assert.deepEqual(lowSources({ a: st(30) }, three), []);
  assert.deepEqual(lowSources({ a: st(0, true) }, three), [], 'a failed source is reported as failed, not low');
  // Failed runs and runs without the source do not count; only the last 7 do.
  const mixed = [...Array.from({ length: 10 }, (_, i) => run(i, { a: st(i < 3 ? 1000 : 50) })), run(11, { a: st(0, true) }), run(12, { b: st(5) })];
  assert.deepEqual(lowSources({ a: st(16) }, mixed), [], 'median of the last 7 good runs is 50');
  assert.deepEqual(lowSources({ a: st(14) }, mixed), ['a']);
});

test('recordScan writes status, history (last 60) and source_runs; partial runs keep other sources', () => {
  const ctx = makeCtx();
  for (let i = 0; i < HISTORY_KEEP + 5; i++) recordScan(ctx, run(i, { a: st(100), b: st(50) }));
  assert.equal(readHistory(ctx).length, HISTORY_KEEP);
  assert.equal(readHistory(ctx).at(-1)!.scan_id, `s${HISTORY_KEEP + 4}`);
  const { low_sources } = recordScan(ctx, run(99, { a: st(10) }));
  assert.deepEqual(low_sources, ['a']);
  const status = readStatus(ctx)!;
  assert.equal(status.last_scan_id, 's99');
  assert.equal(status.sources.a.low, true);
  assert.equal(status.sources.b.scan_id, `s${HISTORY_KEEP + 4}`, 'a run of one source leaves the others in place');
  assert.deepEqual(status.low_sources, ['a']);
  const rows = ctx.db().prepare("SELECT source, listed, status, scan_id FROM source_runs WHERE scan_id = 's99'").all();
  assert.deepEqual(rows.map((r: any) => ({ ...r })), [{ source: 'a', listed: 10, status: 'ok', scan_id: 's99' }]);
  assert.ok(!fs.readdirSync(ctx.paths.userDir).some((f) => f.endsWith('.tmp')));
});
