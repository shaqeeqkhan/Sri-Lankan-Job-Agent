import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAdapter } from '../src/sources/load.ts';
import { fixtureContext } from './source-helpers.ts';

// jobsnet had no job board to read on 15 Nov 2026 (see src/sources/jobsnet/index.ts). The adapter loads,
// fails the whole source with a clear reason, makes no requests, and never calls a job closed.
test('jobsnet: loads, and a scan fails the whole source with the reason', async () => {
  const adapter = await loadAdapter('jobsnet');
  const ctx = fixtureContext({ source: 'jobsnet' });
  assert.equal(ctx.source.enabled, false);
  await assert.rejects(adapter.scan(ctx), (err: Error & { code?: string }) => err.code === 'FETCH_FAILED' && /new web server/.test(err.message));
  assert.equal(await adapter.recheck({ source_url: 'https://jobsnet.lk/x', external_id: 'x' }, ctx), 'unknown');
  assert.deepEqual(ctx.calls, { pages: [], http: [] });
});
