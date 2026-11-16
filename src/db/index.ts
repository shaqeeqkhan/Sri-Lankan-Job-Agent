import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations.ts';

export type DB = Database.Database;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB): { applied: number[]; version: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const done = new Set(
    db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[],
  );
  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
    applied.push(m.version);
  }
  return { applied, version: schemaVersion(db) };
}

export function schemaVersion(db: DB): number {
  return (db.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').pluck().get() as number) ?? 0;
}

export function kvGet(db: DB, key: string): string | undefined {
  return db.prepare('SELECT value FROM kv WHERE key = ?').pluck().get(key) as string | undefined;
}

export function kvSet(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}
