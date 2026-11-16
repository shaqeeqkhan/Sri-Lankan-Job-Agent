import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAdapter } from '../src/sources/load.ts';
import { fixtureContext } from './source-helpers.ts';

// careers360 had no job board to read on 15 Nov 2026 (see src/sources/careers360/index.ts). The adapter loads,
// fails the whole source with a clear reason, makes no requests, and never calls a job closed.
test('careers360: loads, and a scan fails the whole source with the reason', async () => {
  const adapter = await loadAdapter('careers360');
  const ctx = fixtureContext({ source: 'careers360' });
  assert.equal(ctx.source.enabled, false);
  await assert.rejects(adapter.scan(ctx), (err: Error & { code?: string }) => err.code === 'FETCH_FAILED' && /redirects to hotjobs\.lk/.test(err.message));
  assert.equal(await adapter.recheck({ source_url: 'https://careers360.lk/x', external_id: 'x' }, ctx), 'unknown');
  assert.deepEqual(ctx.calls, { pages: [], http: [] });
});
