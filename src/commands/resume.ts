import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand, type Command } from '../registry.ts';
import { importResume, lastImport, RESUME_EXTS } from '../resume/import.ts';
import { checkProfile } from '../resume/profile-check.ts';
import { resumeSaved, saveResume } from '../resume/save.ts';
import { resumeHash } from '../user/profile.ts';

export const resumeImport = defineCommand({
  name: 'resume.import',
  summary:
    `Convert a CV (${RESUME_EXTS.join(', ')}) to Markdown in user/resume.raw.md, and on first import also user/resume.md. ` +
    'With no file, uses the newest CV in user/inbox/. A scanned PDF or a photo returns status NEEDS_VISION with page images for you to read.',
  sideEffect: 'Copies the CV to user/inbox/, writes user/resume.raw.md (and user/resume.md when missing or --force), records the import',
  positional: 'file',
  input: z.object({
    file: z.string().max(1000).optional().describe('Path to the CV, or a file name in user/inbox/. Omit to use the newest CV in user/inbox/.'),
    force: z.boolean().default(false).describe('Overwrite an existing user/resume.md with this conversion.'),
  }),
  run: (input, ctx) => importResume(ctx, input),
  format: (d) =>
    [
      d.status === 'NEEDS_VISION' ? `NEEDS_VISION: ${d.source_path} has no usable text layer.` : `Imported ${d.source_path} (${d.method}).`,
      `  ${d.pages} page(s), ${d.characters} characters, ${d.headings} headings, ${d.bullets} bullets, ${d.tables} tables, ${d.links} links${d.two_column ? ', two-column layout' : ''}`,
      d.raw_path ? `  raw: ${d.raw_path}` : null,
      `  resume.md: ${d.resume_written ? 'written' : 'kept as it was'} (${d.resume_path})`,
      ...d.images.map((i: string) => `  image: ${i}`),
      ...d.warnings.map((w: string) => `  ! ${w}`),
      `  next: ${d.next_step}`,
    ]
      .filter(Boolean)
      .join('\n'),
});

export const resumeSave = defineCommand({
  name: 'resume.save',
  summary:
    'Run after you write the cleaned user/resume.md. Checks it against user/resume.raw.md for added words or numbers (clean-up must never add content), ' +
    'records it, and returns a short summary of what changed to show the person.',
  sideEffect: 'Records the cleaned resume.md hash',
  input: z.object({
    accept_additions: z
      .boolean()
      .default(false)
      .describe('Save even though resume.md has words not in the original. Only after the person confirmed each one is a correction (a typo or a word broken by the PDF).'),
  }),
  run: (input, ctx) => saveResume(ctx, input),
  isFailure: (d) => !d.saved,
  format: (d) =>
    [
      d.saved ? `Saved user/resume.md (${d.resume_hash}).` : 'NOT saved.',
      `  ${d.summary}`,
      ...d.additions.slice(0, 10).map((a: { line: string; words: string[] }) => `  + ${a.words.join(', ')}  in: ${a.line}`),
      ...d.dropped.slice(0, 10).map((a: { line: string; words: string[] }) => `  - ${a.words.join(', ')}  from: ${a.line}`),
      d.note ? `  · ${d.note}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
});

export const resumeStatus = defineCommand({
  name: 'resume.status',
  summary: 'Whether user/resume.md and user/profile.yml exist and are valid, the resume hash scores are keyed by, and the last import.',
  sideEffect: null,
  input: z.object({}),
  run(_input, ctx) {
    const p = ctx.paths;
    const resumeExists = fs.existsSync(p.resumeFile);
    const text = resumeExists ? fs.readFileSync(p.resumeFile, 'utf8') : '';
    const resume = {
      exists: resumeExists,
      path: p.resumeFile,
      characters: text.length,
      hash: resumeExists ? resumeHash(ctx) : null,
      saved: resumeExists && resumeSaved(ctx),
      same_as_raw: resumeExists && fs.existsSync(p.resumeRawFile) && fs.readFileSync(p.resumeRawFile, 'utf8') === text,
    };
    const raw = { exists: fs.existsSync(p.resumeRawFile), path: p.resumeRawFile };
    const profileExists = fs.existsSync(p.profileFile);
    let profile: { exists: boolean; path: string; valid: boolean; problems: string[]; summary: string | null } = {
      exists: profileExists,
      path: p.profileFile,
      valid: false,
      problems: profileExists ? [] : ['missing'],
      summary: null,
    };
    if (profileExists && resumeExists) {
      const c = checkProfile(ctx);
      profile = { ...profile, valid: c.valid, problems: c.problems, summary: c.summary };
    } else if (profileExists) profile.problems = ['user/resume.md is missing, and the profile is derived from it'];
    const imp = lastImport(ctx);
    let next: string | null = null;
    if (!resumeExists) next = 'Import a CV: `slj resume import <file>` (modes/import.md).';
    else if (!resume.saved) next = 'Clean user/resume.md from resume.raw.md, then run `slj resume save`.';
    else if (!profile.valid) next = 'Write user/profile.yml from resume.md (modes/import.md), then run `slj profile check`.';
    return {
      ready: resumeExists && profile.valid,
      resume_hash: resume.hash,
      resume,
      raw,
      profile,
      last_import: imp ? { ...imp, path: path.join(p.userDir, imp.path) } : null,
      next_step: next,
    };
  },
  format: (d) =>
    [
      `resume.md: ${d.resume.exists ? `${d.resume.characters} chars, hash ${d.resume_hash}${d.resume.saved ? ', saved' : ', not saved yet'}` : 'missing'}`,
      `profile.yml: ${d.profile.exists ? (d.profile.valid ? 'valid' : `invalid (${d.profile.problems.join('; ')})`) : 'missing'}`,
      d.last_import ? `last import: ${d.last_import.method} from ${d.last_import.path} at ${d.last_import.imported_at}` : 'last import: none',
      d.profile.summary ? `  ${d.profile.summary}` : null,
      d.next_step ? `next: ${d.next_step}` : 'Ready to scan.',
    ]
      .filter(Boolean)
      .join('\n'),
});

export const profileCheck = defineCommand({
  name: 'profile.check',
  summary:
    'Validate user/profile.yml. Returns problems if it is invalid, and when it is valid, the one-line "I\'ve assumed you\'re looking for…" summary to say to the person.',
  sideEffect: null,
  input: z.object({}),
  run: (_input, ctx) => checkProfile(ctx),
  isFailure: (d) => !d.valid,
  format: (d) =>
    d.valid
      ? [d.summary, ...d.warnings.map((w: string) => `  ! ${w}`)].join('\n')
      : [`user/profile.yml is invalid:`, ...d.problems.map((p: string) => `  - ${p}`)].join('\n'),
});

/** Filled by stream S7 (resume import, save, status; profile check). */
export const resumeCommands: Command[] = [resumeImport as Command, resumeSave as Command, resumeStatus as Command, profileCheck as Command];
