import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';
import { SljError } from '../src/errors.ts';
import { bumpStat, loadFacts, loadProfile, readResume, resumeHash } from '../src/user/profile.ts';
import { makeCtx } from './helpers.ts';

const code = (c: string) => (e: SljError) => e instanceof SljError && e.code === c;

const PROFILE = {
  name: { value: 'Nimali Perera', inferred: true },
  target_titles: { value: ['Data Analyst', 'BI Analyst'], inferred: true },
  adjacent_titles: { value: ['Reporting Analyst'], inferred: true },
  seniority: { value: 'junior', inferred: true },
  years_experience: { value: 2, inferred: true },
  skills: { value: ['SQL', 'Power BI'], inferred: true },
  location: { value: 'Colombo', inferred: true },
  districts_ok: { value: ['Colombo', 'Gampaha'], inferred: true },
  work_mode: { value: 'hybrid', inferred: false },
  cv_style: { value: 'modern', inferred: true },
};

test('resume: NO_RESUME when missing; hash is the first 16 hex of sha256 of the bytes', () => {
  const ctx = makeCtx();
  assert.throws(() => resumeHash(ctx), code('NO_RESUME'));
  assert.throws(() => readResume(ctx), code('NO_RESUME'));
  fs.writeFileSync(ctx.paths.resumeFile, '# Nimali Perera\n');
  assert.equal(resumeHash(ctx), crypto.createHash('sha256').update('# Nimali Perera\n').digest('hex').slice(0, 16));
  assert.equal(readResume(ctx), '# Nimali Perera\n');
});

test('loadProfile: NO_RESUME, then NO_PROFILE when missing or invalid, then the parsed profile', () => {
  const ctx = makeCtx();
  assert.throws(() => loadProfile(ctx), code('NO_RESUME'));
  fs.writeFileSync(ctx.paths.resumeFile, '# CV\n');
  assert.throws(() => loadProfile(ctx), code('NO_PROFILE'));

  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify({ ...PROFILE, target_titles: { value: ['a', 'b', 'c', 'd'], inferred: true } }));
  assert.throws(() => loadProfile(ctx), (e: SljError) => e.code === 'NO_PROFILE' && /target_titles/.test(e.message));
  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify({ ...PROFILE, seniority: { value: 'guru', inferred: true } }));
  assert.throws(() => loadProfile(ctx), code('NO_PROFILE'));
  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify({ ...PROFILE, skills: ['SQL'] }));
  assert.throws(() => loadProfile(ctx), code('NO_PROFILE'), 'every field is { value, inferred }');

  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify(PROFILE));
  const p = loadProfile(ctx);
  assert.equal(p.seniority.value, 'junior');
  assert.equal(p.work_mode.inferred, false);
  assert.equal(p.salary_floor, undefined);
  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify({ ...PROFILE, salary_floor: { value: 150000, inferred: false } }));
  assert.equal(loadProfile(ctx).salary_floor?.value, 150000);
});

test('loadFacts: none when missing, validated list otherwise', () => {
  const ctx = makeCtx();
  assert.deepEqual(loadFacts(ctx), []);
  fs.writeFileSync(ctx.paths.factsFile, '');
  assert.deepEqual(loadFacts(ctx), []);
  const fact = { id: 'f1', text: 'Built the monthly sales dashboard used by 40 branch managers', kind: 'metric', source: 'interview', confirmed: true, added_at: '2026-11-15T04:00:00Z' };
  fs.writeFileSync(ctx.paths.factsFile, YAML.stringify([fact]));
  assert.deepEqual(loadFacts(ctx), [fact]);
  fs.writeFileSync(ctx.paths.factsFile, YAML.stringify([{ ...fact, confirmed: false }]));
  assert.throws(() => loadFacts(ctx), code('INVALID_INPUT'), 'unconfirmed facts are rejected');
  fs.writeFileSync(ctx.paths.factsFile, YAML.stringify([fact, fact]));
  assert.throws(() => loadFacts(ctx), /duplicate fact id/);
});

test('bumpStat counts locally in user/stats.json', () => {
  const ctx = makeCtx();
  assert.equal(bumpStat(ctx, 'scans').scans, 1);
  bumpStat(ctx, 'scans');
  const s = bumpStat(ctx, 'cvs');
  assert.deepEqual({ scans: s.scans, top_reports: s.top_reports, cvs: s.cvs }, { scans: 2, top_reports: 0, cvs: 1 });
  assert.equal(JSON.parse(fs.readFileSync(ctx.paths.statsFile, 'utf8')).scans, 2);
});
