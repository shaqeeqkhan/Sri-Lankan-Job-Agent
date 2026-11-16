import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { migrate, openDb, schemaVersion } from '../src/db/index.ts';
import { LATEST_SCHEMA_VERSION, migrations } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const V2_TABLES = ['jobs', 'job_sources', 'runs', 'audit', 'kv', 'resumes', 'scores', 'top_reports', 'source_runs', 'seen', 'cv_outputs'];
const DROPPED = ['applications', 'emails', 'events', 'portal_accounts', 'qa'];
const NEW_JOB_COLUMNS = ['external_id', 'country_code', 'remote', 'employment_type', 'scraped_at', 'district', 'identity_t1', 'identity_t1b', 'identity_t2', 'closed_at', 'closed_reason'];

const tables = (db: ReturnType<typeof openDb>) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[];

test('migrations create the v2 tables, drop the apply/inbox ones, and are idempotent', () => {
  const file = path.join(tempDir(), 'slj.db');
  const db = openDb(file);
  for (const t of V2_TABLES) assert.ok(tables(db).includes(t), `missing table ${t}`);
  for (const t of DROPPED) assert.ok(!tables(db).includes(t), `table ${t} should be gone`);
  const cols = db.prepare("SELECT name FROM pragma_table_info('jobs')").pluck().all() as string[];
  for (const c of NEW_JOB_COLUMNS) assert.ok(cols.includes(c), `jobs.${c}`);
  const scoreCols = db.prepare("SELECT name FROM pragma_table_info('scores')").pluck().all() as string[];
  assert.ok(scoreCols.includes('breakdown_json'));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'").pluck().all() as string[];
  for (const i of ['jobs_identity_t1', 'jobs_identity_t1b', 'jobs_identity_t2']) assert.ok(idx.includes(i), i);
  assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
  assert.deepEqual(migrate(db).applied, []);
  db.close();
  const again = openDb(file);
  assert.equal(schemaVersion(again), LATEST_SCHEMA_VERSION);
  again.close();
});

test('a Phase 0 database (v1 with rows) upgrades to v2 and keeps its jobs', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const v1 = migrations.find((m) => m.version === 1)!;
  db.exec(v1.sql);
  db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(v1.name, new Date().toISOString());
  const now = new Date().toISOString();
  db.prepare("INSERT INTO jobs (id, source, title, apply_method, fetched_at, updated_at, hash) VALUES ('j1', 's', 't', 'email', ?, ?, 'h')").run(now, now);
  db.prepare("INSERT INTO applications (id, job_id, status, channel, created_at, updated_at) VALUES ('a', 'j1', 'drafted', 'email', ?, ?)").run(now, now);
  db.prepare("INSERT INTO scores (job_id, score, recommendation, created_at) VALUES ('j1', 4, 'apply', ?)").run(now);
  // Every later migration applies, in version order (streams appended them out of order).
  assert.deepEqual(migrate(db).applied, migrations.filter((m) => m.version > 1).map((m) => m.version));
  assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) FROM jobs').pluck().get(), 1);
  assert.ok(!tables(db).includes('applications'));
});

test('migrations are sorted by version, unique, and latest is the highest', () => {
  const versions = migrations.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(LATEST_SCHEMA_VERSION, Math.max(...versions));
  assert.ok(versions.includes(30) && versions.includes(40));
});

test('v2 scores: points 0-100, stars 1-5, one row per (job, resume, rubric)', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  db.prepare("INSERT INTO jobs (id, source, title, apply_method, fetched_at, updated_at, hash) VALUES ('j1', 's', 't', 'email', ?, ?, 'h')").run(now, now);
  const ins = db.prepare('INSERT INTO scores (job_id, resume_hash, rubric_version, points, stars, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('j1', 'r1', 'v1', 72, 4, now);
  assert.throws(() => ins.run('j1', 'r1', 'v1', 80, 4, now), /UNIQUE/);
  assert.throws(() => ins.run('j1', 'r2', 'v1', 101, 5, now), /CHECK/);
  assert.throws(() => ins.run('j1', 'r3', 'v1', 50, 6, now), /CHECK/);
  ins.run('j1', 'r1', 'v2', 72, 4, now);
  assert.throws(() =>
    db.prepare("INSERT INTO cv_outputs (job_id, style, created_at) VALUES ('j1', 'fancy', ?)").run(now),
  );
});
