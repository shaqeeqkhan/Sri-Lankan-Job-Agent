import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { allPlatforms, loadConfig, platformForHost } from '../src/config.ts';
import { SljError } from '../src/errors.ts';
import { resolvePaths } from '../src/paths.ts';
import { ROOT, tempDir } from './helpers.ts';

const CONFIG = path.join(ROOT, 'config');

function copyConfig(): string {
  const dir = tempDir();
  fs.cpSync(CONFIG, dir, { recursive: true });
  return dir;
}
function edit(dir: string, file: string, from: string | RegExp, to: string) {
  const p = path.join(dir, file);
  const text = fs.readFileSync(p, 'utf8');
  const next = text.replace(from, to);
  assert.notEqual(next, text, `edit did not apply to ${file}`);
  fs.writeFileSync(p, next);
}
const invalid = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: SljError) => e instanceof SljError && e.code === 'CONFIG_INVALID' && (!re || re.test(e.message)));

test('the shipped config loads, with the v2 settings', () => {
  const c = loadConfig(CONFIG, {});
  assert.deepEqual(c.settings.stars, { five: 85, four: 70, three: 55, two: 40 });
  assert.equal(c.settings.top_n, 20);
  assert.equal(c.settings.prefilter_n, 60);
  assert.equal(c.settings.score_batch, 10);
  assert.equal(c.settings.scan.source_workers, 6);
  assert.equal(c.settings.cv.page_size, 'A4');
  assert.deepEqual(c.settings.cv.watermark, { enabled: true, size_pt: 6, text: 'Resume designed by srilankanjobs.lk', color: '#9aa0a6' });
  // boards.json is seeded with verified boards: every ATS family is present, every board is named.
  assert.deepEqual(Object.keys(c.boards).sort(), ['ashby', 'greenhouse', 'lever', 'smartrecruiters', 'workday']);
  const all = Object.values(c.boards).flat() as { name: string; company: string }[];
  assert.ok(all.length > 0, 'boards.json has seeded boards');
  for (const b of all) assert.ok(b.name && b.company, JSON.stringify(b));
  for (const b of c.boards.workday as { name: string }[]) assert.match(b.name, /^[^|]+\|wd\d+\|[^|]+$/);
  assert.ok(!('caps' in c.settings) && !('auto_mode' in c.settings));
});

test('SLJ_SOURCE_WORKERS overrides scan.source_workers and is validated', () => {
  assert.equal(loadConfig(CONFIG, { SLJ_SOURCE_WORKERS: '2' }).settings.scan.source_workers, 2);
  invalid(() => loadConfig(CONFIG, { SLJ_SOURCE_WORKERS: 'lots' }), /SLJ_SOURCE_WORKERS/);
  invalid(() => loadConfig(CONFIG, { SLJ_SOURCE_WORKERS: '0' }));
});

test('a bad or missing config file throws CONFIG_INVALID; nothing falls back to empty', () => {
  let d = copyConfig();
  fs.writeFileSync(path.join(d, 'sources.yml'), '');
  invalid(() => loadConfig(d, {}), /sources\.yml is empty/);

  d = copyConfig();
  fs.writeFileSync(path.join(d, 'boards.json'), '{ "workday": [ ');
  invalid(() => loadConfig(d, {}), /boards\.json/);

  d = copyConfig();
  fs.writeFileSync(path.join(d, 'boards.json'), '{ "workday": [] }');
  invalid(() => loadConfig(d, {}), /greenhouse/);

  d = copyConfig();
  fs.rmSync(path.join(d, 'boards.json'));
  invalid(() => loadConfig(d, {}), /Cannot read boards\.json/);

  d = copyConfig();
  edit(d, 'sources.yml', /tiers: \[[^\]]*\]/, 'tiers: [T9]');
  invalid(() => loadConfig(d, {}), /tiers/);

  d = copyConfig();
  edit(d, 'sources.yml', '- id: ikman', '- id: xpressjobs');
  invalid(() => loadConfig(d, {}), /duplicate id "xpressjobs"/);

  d = copyConfig();
  edit(d, 'settings.yml', 'four: 70', 'four: 90');
  invalid(() => loadConfig(d, {}), /star bands/);

  d = copyConfig();
  edit(d, 'settings.yml', /\n {2}watermark:[\s\S]*$/, '\n');
  invalid(() => loadConfig(d, {}), /cv\.watermark/);
});

test('platformForHost labels a link from both the scanned sources and the label-only platforms', () => {
  const { sources } = loadConfig(CONFIG, {});
  assert.equal(platformForHost(sources, 'www.xpress.jobs')?.id, 'xpressjobs');
  assert.equal(platformForHost(sources, 'acme.wd3.myworkdayjobs.com')?.id, 'workday');
  assert.equal(platformForHost(sources, 'm.facebook.com')?.kind, 'social');
  assert.equal(platformForHost(sources, 'lk.linkedin.com')?.fetch_policy, 'no_automated_fetch');
  assert.equal(platformForHost(sources, 'career5.successfactors.eu')?.id, 'successfactors');
  assert.equal(platformForHost(sources, 'notxpress.jobs.example'), undefined);
  assert.equal(platformForHost(allPlatforms(sources), 'topjobs.lk')?.id, 'topjobs');
  assert.equal(platformForHost(sources.platforms, 'topjobs.lk'), undefined, 'a plain array searches only itself');
});

test('paths: the v2 user/ layout, moved by SLJ_HOME and SLJ_CONFIG_DIR', () => {
  const p = resolvePaths({ SLJ_HOME: '/tmp/slj-a', SLJ_CONFIG_DIR: '/tmp/slj-c' }, ROOT);
  assert.equal(p.userDir, '/tmp/slj-a');
  assert.equal(p.configDir, '/tmp/slj-c');
  assert.equal(p.resumeFile, '/tmp/slj-a/resume.md');
  assert.equal(p.resumeRawFile, '/tmp/slj-a/resume.raw.md');
  assert.equal(p.profileFile, '/tmp/slj-a/profile.yml');
  assert.equal(p.factsFile, '/tmp/slj-a/facts.yml');
  assert.equal(p.outputDir, '/tmp/slj-a/output');
  assert.equal(p.scanHistoryFile, '/tmp/slj-a/scan_history.jsonl');
  assert.equal(resolvePaths({}, ROOT).userDir, path.join(ROOT, 'user'));
});
