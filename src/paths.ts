import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Repo root: the folder that holds AGENTS.md, config/ and modes/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The v2 `user/` layout (PRD §6, §9). Everything personal lives under `userDir`. */
export interface Paths {
  root: string;
  configDir: string;
  userDir: string;
  /** user/slj.db */
  dbFile: string;
  /** user/resume.md: the cleaned CV, source of truth. */
  resumeFile: string;
  /** user/resume.raw.md: the deterministic conversion, before the agent cleans it. */
  resumeRawFile: string;
  /** user/profile.yml: inferred targets, each field { value, inferred }. */
  profileFile: string;
  /** user/facts.yml: confirmed interview facts. */
  factsFile: string;
  /** user/stats.json: local counters, never uploaded. */
  statsFile: string;
  /** user/inbox/: CVs and ads the person dropped in. */
  inboxDir: string;
  /** user/reports/: <date>-top20.md */
  reportsDir: string;
  /** user/output/<job-id>/: cv.md, cv.html, *.pdf */
  outputDir: string;
  /** user/cache/: fetch cache (listing / detail / last-good). */
  cacheDir: string;
  /** user/browser-profile/: persistent Chrome profile for the browser tiers. */
  browserProfileDir: string;
  /** user/browser-status.json: waiting_for_human state for the agent. */
  browserStatusFile: string;
  /** user/scan_status.json: per-source result of the last scan. */
  scanStatusFile: string;
  /** user/scan_history.jsonl: last 60 scans. */
  scanHistoryFile: string;
}

/** Folders `slj doctor` creates. */
export function userDirs(p: Paths): string[] {
  return [p.userDir, p.inboxDir, p.reportsDir, p.outputDir, p.cacheDir, p.browserProfileDir];
}

/**
 * SLJ_HOME moves the personal data folder (tests, helpers running it for several people).
 * SLJ_CONFIG_DIR moves config/ (tests only).
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env, root = ROOT): Paths {
  const userDir = path.resolve(env.SLJ_HOME ?? path.join(root, 'user'));
  const u = (name: string) => path.join(userDir, name);
  return {
    root,
    configDir: path.resolve(env.SLJ_CONFIG_DIR ?? path.join(root, 'config')),
    userDir,
    dbFile: u('slj.db'),
    resumeFile: u('resume.md'),
    resumeRawFile: u('resume.raw.md'),
    profileFile: u('profile.yml'),
    factsFile: u('facts.yml'),
    statsFile: u('stats.json'),
    inboxDir: u('inbox'),
    reportsDir: u('reports'),
    outputDir: u('output'),
    cacheDir: u('cache'),
    browserProfileDir: u('browser-profile'),
    browserStatusFile: u('browser-status.json'),
    scanStatusFile: u('scan_status.json'),
    scanHistoryFile: u('scan_history.jsonl'),
  };
}
