/**
 * `slj resume save`: checks the agent's cleaned user/resume.md against user/resume.raw.md.
 * Clean-up may rejoin lines, fix bullets and reorder sections. It must never add content (PRD §5.1),
 * so any word or number in resume.md that is not in the raw conversion is reported.
 */
import fs from 'node:fs';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { resumeHash } from '../user/profile.ts';
import { lastImport, type ImportMethod } from './import.ts';

/** Words that carry no facts. Adding one ("and", "the") is not adding content. */
const FUNCTION_WORDS = new Set(
  'a an the and or of in on at to for with by from as is are was were be been as per via its it this that these those'.split(' '),
);

const MAX_REPORTED = 15;

export interface Addition {
  line: string;
  words: string[];
}

export interface DiffHunk {
  kind: 'rejoined' | 'reformatted' | 'changed' | 'removed' | 'added';
  before: string[];
  after: string[];
}

export interface SaveCheck {
  checked_against_raw: boolean;
  additions: Addition[];
  added_numbers: string[];
  /** Raw lines with words that no longer appear in resume.md. Not an error, but the person should see them. */
  dropped: { line: string; words: string[] }[];
  hunks: DiffHunk[];
  unchanged_lines: number;
  summary: string;
}

// ---------------------------------------------------------------- tokens

/** Lower-cased word and number tokens, with Markdown syntax and link targets stripped. */
export function tokens(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      // Keep link text, and the address as its own tokens (so a link that was kept is not "added").
      .replace(/\]\(([^)]*)\)/g, ' $1 ')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

const isNumber = (t: string) => /\d/.test(t);

interface Vocab {
  words: Set<string>;
  /** Adjacent tokens glued together, so "manage ment" → "management" or "18 000" → "18000" are not additions. */
  joined: Set<string>;
  list: string[];
}

function vocab(text: string): Vocab {
  const list = tokens(text);
  const words = new Set(list);
  const joined = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    let s = list[i];
    for (let j = i + 1; j < Math.min(list.length, i + 4); j++) {
      s += list[j];
      joined.add(s);
    }
  }
  return { words, joined, list };
}

function known(t: string, v: Vocab): boolean {
  if (v.words.has(t) || v.joined.has(t)) return true;
  if (FUNCTION_WORDS.has(t)) return true;
  if (isNumber(t)) return false;
  // A run-together word split back apart ("ReactNode" → "React Node"): a piece of a raw word.
  if (t.length >= 3) for (const w of v.words) if (w.length >= t.length + 2 && (w.startsWith(t) || w.endsWith(t))) return true;
  return false;
}

// ---------------------------------------------------------------- line diff

const norm = (l: string) => l.replace(/\s+/g, ' ').trim();

function lcsDiff(a: string[], b: string[]): { op: '=' | '-' | '+'; line: string }[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: '=' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: '=', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', line: a[i++] });
    else out.push({ op: '+', line: b[j++] });
  }
  while (i < n) out.push({ op: '-', line: a[i++] });
  while (j < m) out.push({ op: '+', line: b[j++] });
  return out;
}

function hunksOf(raw: string, clean: string): { hunks: DiffHunk[]; unchanged: number } {
  const a = raw.split('\n').map(norm).filter(Boolean);
  const b = clean.split('\n').map(norm).filter(Boolean);
  const ops = lcsDiff(a, b);
  const hunks: DiffHunk[] = [];
  let unchanged = 0;
  let cur: DiffHunk | null = null;
  for (const o of ops) {
    if (o.op === '=') {
      unchanged++;
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { kind: 'changed', before: [], after: [] };
      hunks.push(cur);
    }
    (o.op === '-' ? cur.before : cur.after).push(o.line);
  }
  for (const h of hunks) {
    const before = tokens(h.before.join(' ')).join(' ');
    const after = tokens(h.after.join(' ')).join(' ');
    if (!h.after.length) h.kind = 'removed';
    else if (!h.before.length) h.kind = 'added';
    else if (before === after) h.kind = h.after.length < h.before.length ? 'rejoined' : 'reformatted';
    else h.kind = 'changed';
  }
  return { hunks, unchanged };
}

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- check

export function checkClean(raw: string, clean: string): Omit<SaveCheck, 'checked_against_raw'> {
  const v = vocab(raw);
  const additions: Addition[] = [];
  const addedNumbers = new Set<string>();
  for (const line of clean.split('\n')) {
    const added = [...new Set(tokens(line).filter((t) => !known(t, v)))];
    if (!added.length) continue;
    for (const t of added) if (isNumber(t)) addedNumbers.add(t);
    additions.push({ line: clip(norm(line)), words: added });
  }
  const c = vocab(clean);
  const dropped: SaveCheck['dropped'] = [];
  for (const line of raw.split('\n')) {
    const gone = [...new Set(tokens(line).filter((t) => !c.words.has(t) && !c.joined.has(t) && !FUNCTION_WORDS.has(t)))];
    // A word glued to its neighbour in the clean copy is not gone.
    const reallyGone = gone.filter((t) => ![...c.words].some((w) => w.length > t.length && w.includes(t)));
    if (reallyGone.length) dropped.push({ line: clip(norm(line)), words: reallyGone });
  }
  const { hunks, unchanged } = hunksOf(raw, clean);
  const n = (k: DiffHunk['kind']) => hunks.filter((h) => h.kind === k);
  const parts: string[] = [`Kept ${unchanged} line(s) as they were`];
  const rejoined = n('rejoined');
  if (rejoined.length) parts.push(`rejoined ${rejoined.reduce((s, h) => s + h.before.length, 0)} broken line(s) into ${rejoined.reduce((s, h) => s + h.after.length, 0)}`);
  if (n('reformatted').length) parts.push(`reformatted ${n('reformatted').length} place(s) (bullets, headings, spacing)`);
  if (n('changed').length) parts.push(`changed wording in ${n('changed').length} place(s)`);
  if (n('removed').length) parts.push(`removed ${n('removed').reduce((s, h) => s + h.before.length, 0)} line(s)`);
  if (n('added').length) parts.push(`added ${n('added').reduce((s, h) => s + h.after.length, 0)} line(s)`);
  let summary = `${parts.join(', ')}.`;
  summary += additions.length
    ? ` ${additions.length} line(s) have words or numbers that are not in the original: remove them, or show them to the person.`
    : ' Nothing was added.';
  if (dropped.length) summary += ` ${dropped.length} line(s) of the original lost words; check nothing real was dropped.`;
  return {
    additions: additions.slice(0, MAX_REPORTED * 2),
    added_numbers: [...addedNumbers],
    dropped: dropped.slice(0, MAX_REPORTED),
    hunks: hunks.slice(0, MAX_REPORTED).map((h) => ({ kind: h.kind, before: h.before.slice(0, 6).map((l) => clip(l)), after: h.after.slice(0, 6).map((l) => clip(l)) })),
    unchanged_lines: unchanged,
    summary,
  };
}

export interface SaveResult extends SaveCheck {
  saved: boolean;
  resume_path: string;
  resume_hash: string;
  method: ImportMethod;
  characters: number;
  note: string | null;
}

/** Minimum size for a CV: anything shorter is a failed transcription or a stub. */
const MIN_CHARS = 150;

export function saveResume(ctx: Context, opts: { accept_additions?: boolean } = {}): SaveResult {
  let clean: string;
  try {
    clean = fs.readFileSync(ctx.paths.resumeFile, 'utf8');
  } catch {
    throw new SljError('NO_RESUME', 'There is no user/resume.md. Write it first (modes/import.md), then run `slj resume save`.', { path: ctx.paths.resumeFile });
  }
  const meaningful = clean.replace(/\s/g, '').length;
  const lines = clean.split('\n').filter((l) => l.trim()).length;
  if (meaningful < MIN_CHARS || lines < 3) {
    throw new SljError('FILE_REJECTED', `user/resume.md has only ${meaningful} characters on ${lines} line(s). That is not a whole CV: write out the full CV first.`, {
      characters: meaningful,
      lines,
    });
  }
  const imp = lastImport(ctx);
  const method: ImportMethod = imp?.method ?? 'plain';
  let check: SaveCheck;
  let note: string | null = null;
  const raw = fs.existsSync(ctx.paths.resumeRawFile) ? fs.readFileSync(ctx.paths.resumeRawFile, 'utf8') : null;
  if (method === 'vision' || raw === null) {
    note =
      method === 'vision'
        ? 'This CV was transcribed from images, so there is no text conversion to check against. Read it back to the person if anything was hard to make out.'
        : 'There is no resume.raw.md to check against, so the added-content check was skipped.';
    check = { checked_against_raw: false, additions: [], added_numbers: [], dropped: [], hunks: [], unchanged_lines: 0, summary: note };
  } else {
    check = { checked_against_raw: true, ...checkClean(raw, clean) };
  }
  const blocked = check.additions.length > 0 && !opts.accept_additions;
  const hash = resumeHash(ctx);
  if (!blocked) {
    ctx.db().prepare('INSERT INTO resumes (hash, path, imported_at, method) VALUES (?, ?, ?, ?)').run(hash, 'resume.md', ctx.now().toISOString(), method);
  } else {
    note = 'Not saved: resume.md has content that is not in the original CV. Remove it, or, if the person confirms each change is a correction, run again with --accept-additions.';
  }
  return { saved: !blocked, resume_path: ctx.paths.resumeFile, resume_hash: hash, method, characters: clean.length, note, ...check };
}

/** Whether the current resume.md has been through `resume save`. */
export function resumeSaved(ctx: Context): boolean {
  try {
    const hash = resumeHash(ctx);
    return !!ctx.db().prepare("SELECT 1 FROM resumes WHERE path = 'resume.md' AND hash = ?").get(hash);
  } catch {
    return false;
  }
}
