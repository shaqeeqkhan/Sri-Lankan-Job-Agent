import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAdapter } from '../src/sources/load.ts';
import { fixtureContext } from './source-helpers.ts';

// jobber had no job board to read on 15 Nov 2026 (see src/sources/jobber/index.ts). The adapter loads,
// fails the whole source with a clear reason, makes no requests, and never calls a job closed.
test('jobber: loads, and a scan fails the whole source with the reason', async () => {
  const adapter = await loadAdapter('jobber');
  const ctx = fixtureContext({ source: 'jobber' });
  assert.equal(ctx.source.enabled, false);
  await assert.rejects(adapter.scan(ctx), (err: Error & { code?: string }) => err.code === 'FETCH_FAILED' && /error 522/.test(err.message));
  assert.equal(await adapter.recheck({ source_url: 'https://jobber.lk/x', external_id: 'x' }, ctx), 'unknown');
  assert.deepEqual(ctx.calls, { pages: [], http: [] });
});
