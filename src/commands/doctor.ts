import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Context } from '../context.ts';
import { schemaVersion } from '../db/index.ts';
import { LATEST_SCHEMA_VERSION, migrations } from '../db/migrations.ts';
import { SljError } from '../errors.ts';
import { userDirs } from '../paths.ts';
import { defineCommand } from '../registry.ts';

type Status = 'pass' | 'warn' | 'fail' | 'info';
interface Check {
  id: string;
  status: Status;
  message: string;
  fix?: string;
}

const MIN_NODE: [number, number] = [22, 18];

const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', 'CODEX.md', 'GEMINI.md', 'OPENCODE.md', '.agents/skills/slj/SKILL.md'];
// Codex, Gemini CLI and OpenCode read .agents/skills directly; Claude Code needs a link.
/** `.claude/skills` is one directory symlink to `../.agents/skills`; both skills must resolve through it. */
const SKILL_LINKS = ['.claude/skills/slj', '.claude/skills/resume-tailor'];
/** v2 mode files (PRD §6). A missing one is a warning while the v2 build is in progress. */
const MODES = ['_shared', 'import', 'scan', 'score', 'report', 'tailor'];
const AI_CLIS = ['claude', 'codex', 'gemini', 'opencode'];

function onPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

function nodeCheck(): Check {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return ok
    ? { id: 'node', status: 'pass', message: `Node ${process.versions.node}` }
    : { id: 'node', status: 'fail', message: `Node ${process.versions.node} is too old.`, fix: `Install Node ${MIN_NODE.join('.')} or newer.` };
}

function userDirChecks(ctx: Context): Check[] {
  const { userDir, root } = ctx.paths;
  try {
    for (const d of userDirs(ctx.paths)) fs.mkdirSync(d, { recursive: true });
    fs.accessSync(userDir, fs.constants.W_OK);
  } catch (err) {
    return [{ id: 'user_dir', status: 'fail', message: `Cannot write ${userDir}: ${(err as Error).message}` }];
  }
  const checks: Check[] = [{ id: 'user_dir', status: 'pass', message: `Personal data folder: ${userDir}` }];
  if (userDir.startsWith(root + path.sep)) {
    const ignore = fs.existsSync(path.join(root, '.gitignore')) ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8') : '';
    const rel = path.relative(root, userDir).split(path.sep)[0];
    checks.push(
      ignore.split(/\r?\n/).some((l) => l.trim().replace(/^\/|\/$/g, '') === rel)
        ? { id: 'user_gitignored', status: 'pass', message: `${rel}/ is git-ignored.` }
        : { id: 'user_gitignored', status: 'fail', message: `${rel}/ is not in .gitignore; personal data could be committed.`, fix: `Add "${rel}/" to .gitignore.` },
    );
  }
  return checks;
}

function dbCheck(ctx: Context): Check {
  try {
    const db = ctx.db();
    const version = schemaVersion(db);
    const latest = LATEST_SCHEMA_VERSION;
    const done = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]);
    const missing = migrations.filter((m) => !done.has(m.version)).map((m) => m.version);
    const jobs = db.prepare('SELECT COUNT(*) FROM jobs').pluck().get() as number;
    const integrity = db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') return { id: 'database', status: 'fail', message: `Database check failed: ${integrity}` };
    return version === latest && missing.length === 0
      ? { id: 'database', status: 'pass', message: `Database schema v${version}, ${jobs} job(s).` }
      : { id: 'database', status: 'fail', message: `Database schema v${version}, expected v${latest}${missing.length ? ` (missing migrations ${missing.join(', ')})` : ''}.` };
  } catch (err) {
    return {
      id: 'database',
      status: 'fail',
      message: `Cannot open the database: ${(err as Error).message}`,
      fix: 'Run `npm install` again so the SQLite module is rebuilt for this Node version.',
    };
  }
}

function configCheck(ctx: Context): Check[] {
  try {
    const { settings, sources, boards } = ctx.config();
    const enabled = sources.sources.filter((s) => s.enabled);
    const boardCount = Object.values(boards).reduce((n, list) => n + list.length, 0);
    return [
      {
        id: 'config',
        status: 'pass',
        message: `Settings OK: top ${settings.top_n}, prefilter ${settings.prefilter_n}, rubric ${settings.rubric_version}, watermark ${settings.cv.watermark.enabled ? `on (${settings.cv.watermark.size_pt} pt)` : 'off'}.`,
      },
      {
        id: 'sources',
        status: 'pass',
        message: `${sources.sources.length} sources (${enabled.length} enabled, ${enabled.filter((s) => s.slow).length} of them slow), ${sources.platforms.length} label-only platforms, ${boardCount} ATS board(s).`,
      },
    ];
  } catch (err) {
    const e = err as SljError;
    return [{ id: 'config', status: 'fail', message: e.message, fix: 'Edit the file in config/ back within the allowed range.' }];
  }
}

function agentFileChecks(ctx: Context): Check[] {
  const { root } = ctx.paths;
  const missing = AGENT_FILES.filter((f) => !fs.existsSync(path.join(root, f)));
  const brokenLinks = SKILL_LINKS.filter((l) => !fs.existsSync(path.join(root, l, 'SKILL.md')));
  const missingModes = MODES.filter((m) => !fs.existsSync(path.join(root, 'modes', `${m}.md`)));
  return [
    missing.length
      ? { id: 'agent_files', status: 'fail', message: `Missing: ${missing.join(', ')}` }
      : { id: 'agent_files', status: 'pass', message: 'AGENTS.md, per-agent wrappers and the shared skill are present.' },
    brokenLinks.length
      ? {
          id: 'skill_links',
          status: 'warn',
          message: `Skill links not working: ${brokenLinks.join(', ')}`,
          fix: 'On Windows, enable Developer Mode or run `git config core.symlinks true` and re-clone.',
        }
      : { id: 'skill_links', status: 'pass', message: 'The shared skills (slj, resume-tailor) are linked for Claude Code.' },
    missingModes.length
      ? { id: 'modes', status: 'warn', message: `Missing mode files: ${missingModes.join(', ')}` }
      : { id: 'modes', status: 'pass', message: `${MODES.length} mode files present.` },
  ];
}

function aiCliCheck(ctx: Context): Check {
  const found = AI_CLIS.filter((c) => onPath(c, ctx.env));
  return found.length
    ? { id: 'ai_cli', status: 'info', message: `AI CLIs found: ${found.join(', ')}.` }
    : { id: 'ai_cli', status: 'info', message: 'No AI CLI found on PATH. An IDE agent (Cursor, VS Code, Windsurf) works too.' };
}

function resumeCheck(ctx: Context): Check {
  return fs.existsSync(ctx.paths.resumeFile)
    ? { id: 'resume', status: 'info', message: 'user/resume.md is present.' }
    : { id: 'resume', status: 'info', message: 'No CV imported yet.', fix: 'Drop a CV into user/inbox/ and run `slj resume import <file>`.' };
}

export const doctor = defineCommand({
  name: 'doctor',
  summary: 'Check the install: Node, database, config, agent files and AI CLIs. Creates the user/ folders if missing.',
  sideEffect: null,
  input: z.object({
    offline: z.boolean().default(false).describe('Accepted for compatibility; doctor makes no network requests.'),
  }),
  run(_input, ctx) {
    const checks: Check[] = [
      nodeCheck(),
      ...userDirChecks(ctx),
      dbCheck(ctx),
      ...configCheck(ctx),
      ...agentFileChecks(ctx),
      aiCliCheck(ctx),
      resumeCheck(ctx),
    ];
    const count = (s: Status) => checks.filter((c) => c.status === s).length;
    return { healthy: count('fail') === 0, passed: count('pass'), warnings: count('warn'), failures: count('fail'), checks };
  },
  isFailure: (d) => !d.healthy,
  format: (d) => {
    const icon: Record<Status, string> = { pass: '✓', warn: '!', fail: '✗', info: '·' };
    return [
      ...d.checks.map((c: Check) => `${icon[c.status]} ${c.message}${c.fix ? `\n    → ${c.fix}` : ''}`),
      '',
      d.healthy ? `Ready. ${d.warnings} warning(s).` : `${d.failures} problem(s) to fix.`,
    ].join('\n');
  },
});
