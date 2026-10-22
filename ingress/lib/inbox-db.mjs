import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { transaction } from '../../plugin/lib/outbox-db.mjs'
import { ensurePrivateDir } from '../../plugin/lib/paths.mjs'

// Durable Inbox + long-lived dedupe ledger (spec §11.1). A 202 is returned
// only after the inbox row and the ledger row commit together.

export const INBOX_SCHEMA_VERSION = 1

const SCHEMA_V1 = `
CREATE TABLE inbox (
  inbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  body BLOB,
  body_sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL,
  attempt_header INTEGER,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  projected INTEGER NOT NULL DEFAULT 0,
  stale INTEGER,
  gap_before INTEGER,
  process_attempts INTEGER NOT NULL DEFAULT 0,
  next_process_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at INTEGER,
  UNIQUE (device_id, epoch, event_id)
);
CREATE INDEX inbox_status ON inbox (status, next_process_at);
CREATE TABLE dedupe_ledger (
  device_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  event_id TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  inbox_id INTEGER NOT NULL,
  first_received_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, epoch, event_id)
);
CREATE TABLE conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  event_id TEXT NOT NULL,
  existing_sha256 TEXT NOT NULL,
  received_sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE stream_state (
  device_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  max_applied_sequence INTEGER NOT NULL,
  current_state TEXT,
  normalized_state TEXT,
  main_agent_json TEXT,
  worktree_id TEXT,
  pane_key TEXT,
  provider TEXT,
  linear_issue_json TEXT,
  last_observed_at TEXT NOT NULL,
  last_event_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, epoch, stream_id)
);
CREATE TABLE stream_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  from_sequence INTEGER NOT NULL,
  to_sequence INTEGER NOT NULL,
  detected_at INTEGER NOT NULL
);
CREATE TABLE side_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  effect TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (inbox_id, effect)
);
CREATE TABLE sources (
  device_id TEXT PRIMARY KEY,
  epoch TEXT,
  last_heartbeat_at INTEGER,
  heartbeat_json TEXT,
  last_event_received_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
`

export function openInbox(dataDir) {
  ensurePrivateDir(dataDir)
  const path = join(dataDir, 'inbox.sqlite3')
  const previousUmask = process.umask(0o077)
  let db
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    transaction(db, () => {
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version > INBOX_SCHEMA_VERSION) throw new Error(`inbox schema v${version} is newer than this Ingress`)
      if (version === 0) {
        db.exec(SCHEMA_V1)
        db.exec(`PRAGMA user_version = ${INBOX_SCHEMA_VERSION}`)
      }
    })
  } catch (error) {
    db?.close()
    throw error
  } finally {
    process.umask(previousUmask)
  }
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600)
  }
  return { db, path }
}

export function audit(db, kind, detail, nowMs = Date.now()) {
  db.prepare('INSERT INTO audit_log (at, kind, detail) VALUES (?, ?, ?)').run(nowMs, kind, detail ? JSON.stringify(detail) : null)
}
