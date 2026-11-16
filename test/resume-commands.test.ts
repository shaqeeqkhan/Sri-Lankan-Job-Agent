import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import type { Context } from '../src/context.ts';
import { findCommand } from '../src/commands/index.ts';
import { execute, type Envelope } from '../src/registry.ts';
import { checkClean } from '../src/resume/save.ts';
import { resumeHash } from '../src/user/profile.ts';
import { ROOT, makeCtx, tempDir } from './helpers.ts';

const FIX = path.join(ROOT, 'test/fixtures/resume');

async function run(ctx: Context, name: string, input: Record<string, unknown> = {}): Promise<any> {
  const cmd = findCommand(name);
  assert.ok(cmd, `command ${name} is registered`);
  const env: Envelope = await execute(cmd, input, ctx);
  return env;
}
async function ok(ctx: Context, name: string, input: Record<string, unknown> = {}): Promise<any> {
  const env = await run(ctx, name, input);
  assert.equal(env.ok, true, JSON.stringify(env));
  return env.data;
}

const PROFILE = {
  name: { value: 'Tharindu Wickramasinghe', inferred: true },
  target_titles: { value: ['Software Engineer', 'Backend Engineer'], inferred: true },
  adjacent_titles: { value: ['Java Developer', 'API Developer'], inferred: true },
  seniority: { value: 'senior', inferred: true },
  years_experience: { value: 4, inferred: true },
  skills: { value: ['Java', 'Spring Boot', 'PostgreSQL', 'TypeScript'], inferred: true },
  location: { value: 'Colombo', inferred: true },
  districts_ok: { value: ['Colombo', 'Gampaha'], inferred: true },
  work_mode: { value: 'hybrid', inferred: false },
  cv_style: { value: 'modern', inferred: true },
};

test('the four commands are registered with the right side effects and a positional file', () => {
  assert.equal(findCommand('resume.import')?.positional, 'file');
  assert.ok(findCommand('resume_import')?.sideEffect);
  assert.ok(findCommand('resume.save')?.sideEffect);
  assert.equal(findCommand('resume.status')?.sideEffect, null);
  assert.equal(findCommand('profile_check')?.sideEffect, null);
});

test('resume save: a clean-up that only rejoins and tidies is saved and summarised', async () => {
  const ctx = makeCtx();
  await ok(ctx, 'resume.import', { file: path.join(FIX, 'traditional.pdf') });
  const raw = fs.readFileSync(ctx.paths.resumeRawFile, 'utf8');
  // What an agent might do: drop the "CURRICULUM VITAE" banner to make the name the title, split a line, fix a heading's case.
  const clean = raw
    .replace('# CURRICULUM VITAE\n\nFathima Rizna Mohamed', '# Fathima Rizna Mohamed')
    .replace('## PERSONAL DETAILS', '## Personal Details')
    .replace('Z-Score: 1.4321 District Rank: 112', 'Z-Score: 1.4321\n\nDistrict Rank: 112');
  fs.writeFileSync(ctx.paths.resumeFile, clean);
  const d = await ok(ctx, 'resume.save');
  assert.equal(d.saved, true);
  assert.equal(d.checked_against_raw, true);
  assert.deepEqual(d.additions, []);
  assert.deepEqual(d.added_numbers, []);
  assert.equal(d.resume_hash, resumeHash(ctx));
  assert.ok(d.hunks.length >= 2);
  assert.match(d.summary, /Nothing was added/);
  // "curriculum" and "vitae" are gone from the clean copy: reported, not blocked.
  assert.ok(d.dropped.some((x: { words: string[] }) => x.words.includes('curriculum')));
  const row = ctx.db().prepare("SELECT hash, method FROM resumes WHERE path = 'resume.md'").get();
  assert.deepEqual(row, { hash: resumeHash(ctx), method: 'text' });
});

test('resume save: added words and numbers block the save until the person accepts them', async () => {
  const ctx = makeCtx();
  await ok(ctx, 'resume.import', { file: path.join(FIX, 'modern.pdf') });
  const raw = fs.readFileSync(ctx.paths.resumeRawFile, 'utf8');
  const clean = raw
    .replace('18,000 applications', '25,000 applications')
    .replace('- Mentored three associate engineers', '- Led a team of six engineers and mentored three associate engineers');
  fs.writeFileSync(ctx.paths.resumeFile, clean);
  const env = await run(ctx, 'resume.save');
  assert.equal(env.ok, true);
  const d = env.data;
  assert.equal(d.saved, false);
  assert.ok(findCommand('resume.save')!.isFailure!(d));
  assert.ok(d.added_numbers.includes('25'));
  const words = d.additions.flatMap((a: { words: string[] }) => a.words);
  for (const w of ['25', 'led', 'team', 'six']) assert.ok(words.includes(w), `flags ${w}: ${words}`);
  assert.match(d.summary, /not in the original/);
  assert.equal((ctx.db().prepare("SELECT count(*) AS n FROM resumes WHERE path = 'resume.md'").get() as { n: number }).n, 0);

  const accepted = await ok(ctx, 'resume.save', { accept_additions: true });
  assert.equal(accepted.saved, true);
});

test('checkClean: fixing words broken by the PDF is not adding content', () => {
  const raw = '## Certifications\n\n- Microsoft Certi fi ed: Power BI\nData Analyst manage-\nment of 18 000 records\n';
  const clean = '## Certifications\n\n- Microsoft Certified: Power BI Data Analyst\n- Management of 18000 records\n';
  const r = checkClean(raw, clean);
  assert.deepEqual(r.additions, []);
  assert.ok(r.hunks.length > 0);
  // A run-together word split apart is fine too, a new one is not.
  assert.deepEqual(checkClean('Skills: ReactNative, Python\n', 'Skills: React Native, Python\n').additions, []);
  assert.deepEqual(checkClean('Skills: Python\n', 'Skills: Python, Kotlin\n').additions.map((a) => a.words), [['kotlin']]);
  // Rejoined lines are reported as such.
  const rejoined = checkClean('Built a loan API that handles\n18,000 applications a month.\n', 'Built a loan API that handles 18,000 applications a month.\n');
  assert.equal(rejoined.hunks[0].kind, 'rejoined');
  assert.match(rejoined.summary, /rejoined 2 broken line\(s\) into 1/);
});

test('resume save: a vision import is not checked against raw text; stubs and missing files are refused', async () => {
  const ctx = makeCtx();
  const missing = await run(ctx, 'resume.save');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NO_RESUME');

  const imp = await ok(ctx, 'resume.import', { file: path.join(FIX, 'scanned.pdf') });
  assert.equal(imp.status, 'NEEDS_VISION');
  fs.writeFileSync(ctx.paths.resumeFile, '# Ruwan Pathirana\n');
  const stub = await run(ctx, 'resume.save');
  assert.equal(stub.ok, false);
  assert.equal(stub.error.code, 'FILE_REJECTED');

  // What the agent transcribes from the page image.
  fs.writeFileSync(
    ctx.paths.resumeFile,
    [
      '# Ruwan Pathirana',
      '',
      'Kurunegala · 076 228 4410 · ruwan.p@example.lk',
      '',
      '## Objective',
      '',
      'Seeking a position as an Electrician / Maintenance Technician in a manufacturing plant.',
      '',
      '## Experience',
      '',
      "**Maintenance Technician**, Wayamba Garments (Pvt) Ltd, Kurunegala (2021 – Present)",
      '',
      "- Maintain 120 industrial sewing machines and the factory's 400 kVA generator.",
      '- Carry out monthly preventive maintenance checklists.',
      '',
    ].join('\n'),
  );
  const d = await ok(ctx, 'resume.save');
  assert.equal(d.saved, true);
  assert.equal(d.method, 'vision');
  assert.equal(d.checked_against_raw, false);
  assert.match(d.note, /transcribed from images/);
});

test('resume status walks through import → save → profile', async () => {
  const ctx = makeCtx();
  let s = await ok(ctx, 'resume.status');
  assert.equal(s.ready, false);
  assert.equal(s.resume.exists, false);
  assert.equal(s.resume_hash, null);
  assert.match(s.next_step, /resume import/);

  await ok(ctx, 'resume.import', { file: path.join(FIX, 'modern.pdf') });
  s = await ok(ctx, 'resume.status');
  assert.equal(s.resume.exists, true);
  assert.equal(s.resume.saved, false);
  assert.equal(s.resume.same_as_raw, true);
  assert.equal(s.last_import.method, 'text');
  assert.match(s.next_step, /resume save/);

  await ok(ctx, 'resume.save');
  s = await ok(ctx, 'resume.status');
  assert.equal(s.resume.saved, true);
  assert.equal(s.profile.exists, false);
  assert.match(s.next_step, /profile\.yml/);

  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify(PROFILE));
  s = await ok(ctx, 'resume.status');
  assert.equal(s.ready, true);
  assert.equal(s.resume_hash, resumeHash(ctx));
  assert.equal(s.next_step, null);
  assert.match(s.profile.summary, /^I've assumed/);
});

test('profile check: the assumptions line, soft warnings, problems and missing files', async () => {
  const ctx = makeCtx();
  const none = await run(ctx, 'profile.check');
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'NO_RESUME');
  fs.writeFileSync(ctx.paths.resumeFile, '# CV\n');
  const noProfile = await run(ctx, 'profile.check');
  assert.equal(noProfile.error.code, 'NO_PROFILE');

  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify(PROFILE));
  const d = await ok(ctx, 'profile.check');
  assert.equal(d.valid, true);
  assert.equal(
    d.summary,
    "I've assumed you're looking for senior Software Engineer or Backend Engineer roles in Colombo (or Gampaha), hybrid OK, with about 4 years of experience. " +
      'I\'ll also look at Java Developer or API Developer. Say "change" to fix any of that.',
  );
  assert.deepEqual(d.confirmed_fields, ['work_mode']);
  assert.ok(d.inferred_fields.includes('target_titles'));
  assert.deepEqual(d.warnings, []);

  const fresher = {
    ...PROFILE,
    target_titles: { value: ['Junior Data Analyst', 'BI Analyst'], inferred: true },
    adjacent_titles: { value: [], inferred: true },
    seniority: { value: 'junior', inferred: true },
    years_experience: { value: 0, inferred: true },
    skills: { value: ['SQL'], inferred: true },
    work_mode: { value: 'any', inferred: true },
  };
  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify(fresher));
  const f = await ok(ctx, 'profile.check');
  assert.match(f.summary, /looking for Junior Data Analyst or BI Analyst roles in Colombo \(or Gampaha\), onsite, hybrid or remote, as a fresher\./);
  assert.ok(f.warnings.some((w: string) => /skills/.test(w)));
  assert.ok(f.warnings.some((w: string) => /adjacent/.test(w)));

  fs.writeFileSync(ctx.paths.profileFile, YAML.stringify({ ...PROFILE, seniority: { value: 'guru', inferred: true }, target_titles: { value: [], inferred: true } }));
  const bad = await ok(ctx, 'profile.check');
  assert.equal(bad.valid, false);
  assert.equal(bad.summary, null);
  assert.ok(bad.problems.some((p: string) => p.startsWith('seniority')));
  assert.ok(bad.problems.some((p: string) => p.startsWith('target_titles')));
  assert.ok(findCommand('profile.check')!.isFailure!(bad));

  fs.writeFileSync(ctx.paths.profileFile, 'name: [unclosed');
  const yamlBad = await ok(ctx, 'profile.check');
  assert.equal(yamlBad.valid, false);
});

test('CLI: slj resume import <file> --json, and the NEEDS_VISION status is data, not an error', async () => {
  const home = tempDir();
  const cli = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'bin/slj.mjs'), ...args], { env: { PATH: process.env.PATH, SLJ_HOME: home } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });
  const a = await cli(['resume', 'import', path.join(FIX, 'sales.docx'), '--json']);
  assert.equal(a.code, 0, a.out);
  const env = JSON.parse(a.out);
  assert.equal(env.ok, true);
  assert.equal(env.data.method, 'docx');
  assert.ok(fs.existsSync(path.join(home, 'resume.md')));

  const b = await cli(['resume', 'import', path.join(FIX, 'photo.jpg'), '--json']);
  assert.equal(b.code, 0, b.out);
  assert.equal(JSON.parse(b.out).data.status, 'NEEDS_VISION');

  const c = await cli(['resume', 'status']);
  assert.equal(c.code, 0);
  assert.match(c.out, /last import: vision/);
});
