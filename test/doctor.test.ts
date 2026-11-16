import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { doctor } from '../src/commands/doctor.ts';
import { execute } from '../src/registry.ts';
import { makeCtx, ROOT, stubFetch, tempDir } from './helpers.ts';

test('doctor is healthy on a fresh install and creates user/', async () => {
  const ctx = makeCtx();
  const res = (await execute(doctor, { offline: true }, ctx)) as any;
  assert.ok(res.ok);
  const failed = res.data.checks.filter((c: any) => c.status === 'fail');
  assert.deepEqual(failed, []);
  assert.equal(res.data.healthy, true);
  for (const d of ['inbox', 'reports', 'output', 'cache', 'browser-profile']) assert.ok(fs.existsSync(path.join(ctx.paths.userDir, d)), d);
  assert.equal(doctor.isFailure!(res.data), false);
});

test('doctor makes no network requests', async () => {
  const { fetch, calls } = stubFetch({});
  const res = (await execute(doctor, {}, makeCtx({ fetch }))) as any;
  assert.equal(res.data.healthy, true);
  assert.deepEqual(calls, []);
});

function badConfig(file: string, from: string, to: string) {
  const dir = tempDir();
  fs.cpSync(path.join(ROOT, 'config'), dir, { recursive: true });
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.ok(text.includes(from), `${file} has ${from}`);
  fs.writeFileSync(path.join(dir, file), text.replace(from, to));
  return dir;
}

test('doctor fails on a watermark outside 4-6 pt', async () => {
  const res = (await execute(doctor, { offline: true }, makeCtx({ configDir: badConfig('settings.yml', 'size_pt: 6', 'size_pt: 2') }))) as any;
  const config = res.data.checks.find((c: any) => c.id === 'config');
  assert.equal(config.status, 'fail');
  assert.match(config.message, /cv\.watermark\.size_pt/);
  assert.equal(res.data.healthy, false);
});
