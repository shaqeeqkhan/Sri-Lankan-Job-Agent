import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { boardsCommands } from '../src/commands/boards.ts';
import { loadConfig } from '../src/config.ts';
import { execute } from '../src/registry.ts';
import { ROOT, makeCtx, stubFetch, tempDir } from './helpers.ts';
import { readFixture } from './source-helpers.ts';

const check = boardsCommands.find((c) => c.name === 'boards.check')!;
const LIST = 'https://boards-api.greenhouse.io/v1/boards/infuse/jobs';
const EMPTY = 'https://boards-api.greenhouse.io/v1/boards/apadmi/jobs';

function setup() {
  const configDir = tempDir('slj-boards-');
  for (const f of fs.readdirSync(path.join(ROOT, 'config'))) fs.copyFileSync(path.join(ROOT, 'config', f), path.join(configDir, f));
  const empty = { greenhouse: [], workday: [], lever: [], ashby: [], smartrecruiters: [] };
  fs.writeFileSync(path.join(configDir, 'boards.json'), JSON.stringify(empty));
  const { fetch, calls } = stubFetch({
    [LIST]: JSON.parse(readFixture('greenhouse', 'infuse-list.json')),
    [EMPTY]: { jobs: [{ id: 1, title: 'Flutter Developer', location: { name: 'Amsterdam' } }] },
  });
  return { ctx: makeCtx({ fetch, configDir }), calls, file: path.join(configDir, 'boards.json') };
}

test('boards check reports validity and Sri Lanka postings without writing', async () => {
  const { ctx, file } = setup();
  const r: any = await execute(check, { board: 'infuse', family: 'greenhouse' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.valid, true);
  assert.equal(r.data.total_postings, 4);
  assert.equal(r.data.sri_lanka_postings, 2);
  assert.equal(r.data.sample_titles[0], 'Client Success Representative (Remote within APAC region, Contract)');
  assert.equal(r.data.added, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).greenhouse, []);
  assert.match(check.format!(r.data), /2 Sri Lanka posting\(s\) of 4 open/);
});

test('--add appends a board with Sri Lanka roles, once', async () => {
  const { ctx, file } = setup();
  const r: any = await execute(check, { board: 'https://job-boards.greenhouse.io/infuse/jobs/4740223005', add: true, company: 'INFUSE' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.family, 'greenhouse', 'family read from the link');
  assert.equal(r.data.added, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).greenhouse, [{ name: 'infuse', company: 'INFUSE' }]);
  loadConfig(path.dirname(file), {}); // still valid
  const again: any = await execute(check, { board: 'infuse', family: 'greenhouse', add: true }, ctx);
  assert.equal(again.data.added, false);
  assert.equal(again.data.already_listed, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).greenhouse.length, 1);
});

test('--add refuses a board with no Sri Lanka roles, and an unreadable one', async () => {
  const { ctx, file } = setup();
  const r: any = await execute(check, { board: 'apadmi', family: 'greenhouse', add: true }, ctx);
  assert.equal(r.data.valid, true);
  assert.equal(r.data.sri_lanka_postings, 0);
  assert.equal(r.data.added, false);
  assert.match(r.data.not_added_reason, /no Sri Lanka postings right now/);
  const bad: any = await execute(check, { board: 'nope', family: 'greenhouse', add: true }, ctx);
  assert.equal(bad.data.valid, false);
  assert.equal(bad.data.added, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).greenhouse, []);
});

test('input errors', async () => {
  const { ctx } = setup();
  const noFamily: any = await execute(check, { board: 'infuse' }, ctx);
  assert.equal(noFamily.error.code, 'INVALID_INPUT');
  const notAts: any = await execute(check, { board: 'https://xpress.jobs/jobs/1' }, ctx);
  assert.equal(notAts.error.code, 'INVALID_INPUT');
  const badWd: any = await execute(check, { board: 'lseg', family: 'workday' }, ctx);
  assert.equal(badWd.error.code, 'INVALID_INPUT');
});
