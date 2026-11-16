import { loadConfig, type Config } from './config.ts';
import { openDb, type DB } from './db/index.ts';
import { resolvePaths, type Paths } from './paths.ts';

export interface Context {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  /** Who is driving: claude, codex, gemini, opencode, app, mcp or cli. Recorded in the audit log. */
  driver: string;
  now(): Date;
  fetch: typeof fetch;
  db(): DB;
  config(): Config;
  close(): void;
}

export interface ContextOptions {
  env?: NodeJS.ProcessEnv;
  driver?: string;
  now?: () => Date;
  fetch?: typeof fetch;
}

export function detectDriver(env: NodeJS.ProcessEnv): string {
  if (env.SLJ_DRIVER) return env.SLJ_DRIVER;
  if (env.CLAUDECODE) return 'claude';
  if (env.GEMINI_CLI) return 'gemini';
  if (env.OPENCODE) return 'opencode';
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  return 'cli';
}

/** DB and config are opened lazily so `slj doctor` can still report on a broken install. */
export function createContext(opts: ContextOptions = {}): Context {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);
  let db: DB | undefined;
  let config: Config | undefined;
  return {
    paths,
    env,
    driver: opts.driver ?? detectDriver(env),
    now: opts.now ?? (() => new Date()),
    fetch: opts.fetch ?? globalThis.fetch,
    db: () => (db ??= openDb(paths.dbFile)),
    config: () => (config ??= loadConfig(paths.configDir, env)),
    close: () => {
      db?.close();
      db = undefined;
    },
  };
}
