/**
 * Append-only. Never edit a migration that has shipped; add a new one.
 * Column names follow the PRD data model.
 */
const defined: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE jobs (
  id                 TEXT PRIMARY KEY,
  source             TEXT NOT NULL,
  source_url         TEXT,
  platform           TEXT NOT NULL DEFAULT 'other',
  title              TEXT NOT NULL,
  company            TEXT,
  location           TEXT,
  category           TEXT,
  salary_text        TEXT,
  description        TEXT,
  closing_date       TEXT,
  apply_method       TEXT NOT NULL CHECK (apply_method IN ('email','portal','form','phone','post','unknown')),
  apply_url          TEXT,
  apply_email        TEXT,
  apply_phone        TEXT,
  apply_instructions TEXT,
  subject_instruction TEXT,
  required_docs      TEXT NOT NULL DEFAULT '[]',
  is_image_ad        INTEGER NOT NULL DEFAULT 0,
  image_path         TEXT,
  needs_review       INTEGER NOT NULL DEFAULT 0,
  review_reasons     TEXT NOT NULL DEFAULT '[]',
  posted_at          TEXT,
  fetched_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  hash               TEXT NOT NULL
);
CREATE INDEX jobs_hash ON jobs(hash);
CREATE INDEX jobs_closing ON jobs(closing_date);
CREATE INDEX jobs_fetched ON jobs(fetched_at);

-- Every place a job was seen. Dedupe merges sources into one job row.
CREATE TABLE job_sources (
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_url TEXT,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (source, source_ref)
);
CREATE INDEX job_sources_job ON job_sources(job_id);
CREATE INDEX job_sources_url ON job_sources(source_url);

CREATE TABLE scores (
  id             INTEGER PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  score          REAL NOT NULL CHECK (score BETWEEN 1 AND 5),
  reasons        TEXT NOT NULL DEFAULT '[]',
  blockers       TEXT NOT NULL DEFAULT '[]',
  scam_flags     TEXT NOT NULL DEFAULT '[]',
  recommendation TEXT NOT NULL CHECK (recommendation IN ('apply','maybe','skip')),
  model          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX scores_job ON scores(job_id);

CREATE TABLE applications (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  status          TEXT NOT NULL CHECK (status IN ('drafted','approved','sent','acknowledged','interview','assessment','info_requested','offer','rejected','no_reply','withdrawn')),
  channel         TEXT NOT NULL CHECK (channel IN ('portal','email','phone','post')),
  platform        TEXT,
  cv_style        TEXT CHECK (cv_style IN ('modern','traditional')),
  cv_path         TEXT,
  answers_json    TEXT,
  email_to        TEXT,
  email_subject   TEXT,
  email_body      TEXT,
  approved_at     TEXT,
  approved_by     TEXT CHECK (approved_by IN ('user','auto')),
  submitted_at    TEXT,
  message_id      TEXT,
  portal_ref      TEXT,
  form_screenshot TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX applications_job ON applications(job_id);
CREATE INDEX applications_status ON applications(status);

CREATE TABLE emails (
  id              TEXT PRIMARY KEY,
  application_id  TEXT REFERENCES applications(id),
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  "from"          TEXT,
  sender_kind     TEXT CHECK (sender_kind IN ('recruiter','ats_notification','other')),
  subject         TEXT,
  received_at     TEXT,
  class           TEXT CHECK (class IN ('interview_invite','assessment','video_interview','info_request','rejection','acknowledgement','offer','other')),
  extracted_dates TEXT NOT NULL DEFAULT '[]',
  suggested_reply TEXT,
  raw_ref         TEXT
);
CREATE INDEX emails_application ON emails(application_id);

CREATE TABLE events (
  id             INTEGER PRIMARY KEY,
  application_id TEXT REFERENCES applications(id),
  type           TEXT NOT NULL,
  note           TEXT,
  at             TEXT NOT NULL
);

-- No passwords, ever. Sessions live in the persistent browser profile.
CREATE TABLE portal_accounts (
  platform          TEXT PRIMARY KEY,
  logged_in         INTEGER NOT NULL DEFAULT 0,
  profile_synced_at TEXT,
  last_status_check TEXT,
  adapter_version   TEXT
);

CREATE TABLE qa (
  id            INTEGER PRIMARY KEY,
  question_norm TEXT NOT NULL,
  answer        TEXT NOT NULL,
  platform      TEXT,
  used_count    INTEGER NOT NULL DEFAULT 0,
  last_used     TEXT,
  UNIQUE (question_norm, platform)
);

CREATE TABLE runs (
  id         INTEGER PRIMARY KEY,
  mode       TEXT NOT NULL,
  driver     TEXT NOT NULL,
  started_at TEXT NOT NULL,
  tokens     INTEGER,
  cost       REAL,
  result     TEXT
);

-- Every side-effecting slj command, whoever called it.
CREATE TABLE audit (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  command TEXT NOT NULL,
  driver  TEXT NOT NULL,
  ok      INTEGER NOT NULL,
  summary TEXT
);

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    // v2 (PRD §9, build plan §3.6): no applying or inbox tracking; local scrapers; CV-based scoring.
    // Version ranges for later migrations: S2 10-19, S7 20-29, S8 30-39, S9 40-49, S6 50-59.
    version: 2,
    name: 'v2_resume_to_jobs',
    sql: `
DROP TABLE emails;
DROP TABLE events;
DROP TABLE applications;
DROP TABLE portal_accounts;
DROP TABLE qa;
DROP TABLE scores;

ALTER TABLE jobs ADD COLUMN external_id     TEXT;
ALTER TABLE jobs ADD COLUMN country_code    TEXT;
ALTER TABLE jobs ADD COLUMN remote          INTEGER;
ALTER TABLE jobs ADD COLUMN employment_type TEXT;
ALTER TABLE jobs ADD COLUMN scraped_at      TEXT;
ALTER TABLE jobs ADD COLUMN district        TEXT;
ALTER TABLE jobs ADD COLUMN identity_t1     TEXT;
ALTER TABLE jobs ADD COLUMN identity_t1b    TEXT;
ALTER TABLE jobs ADD COLUMN identity_t2     TEXT;
ALTER TABLE jobs ADD COLUMN closed_at       TEXT;
ALTER TABLE jobs ADD COLUMN closed_reason   TEXT;
CREATE INDEX jobs_identity_t1  ON jobs(identity_t1);
CREATE INDEX jobs_identity_t1b ON jobs(identity_t1b);
CREATE INDEX jobs_identity_t2  ON jobs(identity_t2);
CREATE INDEX jobs_external     ON jobs(platform, external_id);

CREATE TABLE resumes (
  id          INTEGER PRIMARY KEY,
  hash        TEXT NOT NULL,
  path        TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  method      TEXT NOT NULL            -- text | docx | vision
);
CREATE INDEX resumes_hash ON resumes(hash);

CREATE TABLE scores (
  id             INTEGER PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_hash    TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  points         INTEGER NOT NULL CHECK (points BETWEEN 0 AND 100),
  stars          INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  matched_json   TEXT NOT NULL DEFAULT '[]',
  gaps_json      TEXT NOT NULL DEFAULT '[]',
  -- per-dimension points, and per-requirement met/partial/missing with the quoted JD phrase
  breakdown_json TEXT NOT NULL DEFAULT '{}',
  why            TEXT,
  capped_by      TEXT,
  model          TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (job_id, resume_hash, rubric_version)
);
CREATE INDEX scores_resume ON scores(resume_hash, rubric_version);

CREATE TABLE top_reports (
  id           INTEGER PRIMARY KEY,
  resume_hash  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  job_ids_json TEXT NOT NULL DEFAULT '[]',
  pool_size    INTEGER,
  widened_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE source_runs (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  tier         TEXT,
  status       TEXT NOT NULL,
  http_status  INTEGER,
  jobs_found   INTEGER NOT NULL DEFAULT 0,
  challenge    INTEGER NOT NULL DEFAULT 0,
  human_solved INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX source_runs_source ON source_runs(source, started_at);

CREATE TABLE seen (
  identity_hash TEXT NOT NULL,
  source        TEXT NOT NULL,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  PRIMARY KEY (source, identity_hash)
);

CREATE TABLE cv_outputs (
  id               INTEGER PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  style            TEXT NOT NULL CHECK (style IN ('modern','traditional')),
  cv_md_path       TEXT,
  pdf_path         TEXT,
  pages            INTEGER,
  factcheck_passed INTEGER NOT NULL DEFAULT 0,
  ats_json         TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX cv_outputs_job ON cv_outputs(job_id);
`,
  },
  {
    // S2 Pipeline (range 10-19). source_runs carries the counts `sources doctor` and the low-source
    // rule read (mirrored in user/scan_status.json); jobs gets an index for the open-jobs filter.
    version: 10,
    name: 'scan_counts_and_closed_index',
    sql: `
ALTER TABLE source_runs ADD COLUMN scan_id     TEXT;
ALTER TABLE source_runs ADD COLUMN listed      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN deferred    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN duration_ms INTEGER;
CREATE INDEX jobs_closed ON jobs(closed_at);
`,
  },
  {
    // S9: `slj factcheck` results. `cv render` refuses unless the latest check for this job passed
    // for the exact cv.md bytes (cv_hash) and the exact resume.md + facts.yml (corpus_hash).
    version: 40,
    name: 'cv_factchecks',
    sql: `
CREATE TABLE cv_factchecks (
  id               INTEGER PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  cv_hash          TEXT NOT NULL,
  corpus_hash      TEXT NOT NULL,
  passed           INTEGER NOT NULL,
  unsupported_json TEXT NOT NULL DEFAULT '[]',
  checked_at       TEXT NOT NULL
);
CREATE INDEX cv_factchecks_job ON cv_factchecks(job_id, id);
`,
  },
  {
    // S8 Match (range 30-39). Scores are cached by (resume_hash, job_hash, rubric_version): a job whose
    // text changed must be re-scored, so the score remembers the job text it was given.
    // top_reports gets one row per (resume_hash, report_date): the day's fixed numbering (#1, #2, ...),
    // the agent's "How your CV reads" paragraph, and the page sections of the report file.
    version: 30,
    name: 'match_job_hash_and_daily_reports',
    sql: `
ALTER TABLE scores ADD COLUMN job_hash TEXT;
ALTER TABLE top_reports ADD COLUMN report_date TEXT;
ALTER TABLE top_reports ADD COLUMN rubric_version TEXT;
ALTER TABLE top_reports ADD COLUMN summary TEXT;
ALTER TABLE top_reports ADD COLUMN pages_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE top_reports ADD COLUMN updated_at TEXT;
CREATE INDEX top_reports_day ON top_reports(resume_hash, report_date);
`,
  },
  {
    // S8 Match (I2): what an image ad says, transcribed by the agent's own vision (`slj jobs transcribe`).
    // Kept apart from the scraped description: it is the agent's reading, not the site's text. Score quotes
    // (jd_quote) of an image ad are checked against it, and it is part of the job text a score is keyed on.
    version: 31,
    name: 'match_image_ad_transcription',
    sql: `
ALTER TABLE jobs ADD COLUMN ad_text TEXT;
ALTER TABLE jobs ADD COLUMN ad_text_at TEXT;
`,
  },
];

/** Every migration, applied in version order whatever order the streams appended them in. */
export const migrations = [...defined].sort((a, b) => a.version - b.version);

/** The schema version a fully migrated database has: the highest migration version. */
export const LATEST_SCHEMA_VERSION = Math.max(...migrations.map((m) => m.version));
