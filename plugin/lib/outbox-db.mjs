import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OUTBOX_FILENAME, ensurePrivateDir } from './paths.mjs'

// Bridge-owned SQLite outbox shared by the Collector (Orca plugin worker),
// the Sender (LaunchAgent) and the CLI (spec §8). WAL + synchronous=FULL:
// "saved" means the commit reached disk (spec §8.3).

export const OUTBOX_SCHEMA_VERSION = 1

/** Statuses an undelivered event can be in. `dry_run` rows are never sent. */
export const EVENT_STATUSES = ['pending', 'inflight', 'retry_wait', 'delivered', 'blocked_config', 'dead_letter', 'dry_run']

const SCHEMA_V1 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE source_state (
  stream_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  device_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  worktree_id TEXT,
  pane_key TEXT,
  next_sequence INTEGER NOT NULL,
  last_state TEXT,
  last_main_agent_json TEXT,
  last_observed_at INTEGER,
  gap_pending INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE source_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE outbox_events (
  event_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  body BLOB NOT NULL,
  body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  last_error_class TEXT,
  dead_reason TEXT,
  expiry_override INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  dry_run_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (stream_id, sequence)
);
CREATE INDEX outbox_events_status ON outbox_events (status, endpoint_id, next_attempt_at);
CREATE INDEX outbox_events_stream ON outbox_events (stream_id, sequence);
CREATE TABLE delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  summary TEXT,
  request_id TEXT
);
CREATE INDEX delivery_attempts_event ON delivery_attempts (event_id);
CREATE INDEX delivery_attempts_started ON delivery_attempts (started_at);
CREATE TABLE runtime_control (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE endpoints (
  endpoint_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  pending_url TEXT,
  paused_kind TEXT,
  paused_reason TEXT,
  paused_at INTEGER,
  recheck_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE collection_faults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  detail TEXT,
  stream_id TEXT,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  resolved_at INTEGER,
  reported_at INTEGER
);
CREATE INDEX collection_faults_open ON collection_faults (kind, resolved_at);
CREATE TABLE observed_targets (
  worktree_key TEXT NOT NULL,
  worktree_id TEXT,
  pane_key TEXT NOT NULL,
  in_scope INTEGER NOT NULL,
  last_state TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (worktree_key, pane_key)
);
CREATE TABLE config_history (
  revision TEXT PRIMARY KEY,
  first_loaded_at INTEGER NOT NULL,
  loaded_by TEXT NOT NULL,
  config_json TEXT NOT NULL
);
`

export function outboxPath(dir) {
  return join(dir, OUTBOX_FILENAME)
}

function tightenFilePermissions(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = dbPath + suffix
    if (existsSync(file)) chmodSync(file, 0o600)
  }
}

/** Runs `fn` in BEGIN IMMEDIATE; any throw rolls back so no half-written state survives (spec §8.2). */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function migrate(db, nowMs) {
  transaction(db, () => {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > OUTBOX_SCHEMA_VERSION) {
      throw new Error(`outbox schema v${version} is newer than this Bridge (v${OUTBOX_SCHEMA_VERSION}); update the Bridge instead of writing to it`)
    }
    if (version === 0) {
      db.exec(SCHEMA_V1)
      const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      // The epoch identifies this outbox generation; it changes only when the DB is rebuilt (spec §7.2).
      insertMeta.run('epoch', randomUUID())
      insertMeta.run('created_at', String(nowMs))
      db.exec(`PRAGMA user_version = ${OUTBOX_SCHEMA_VERSION}`)
    }
  })
}

/**
 * Opens (creating if needed) the outbox in a 0700 directory with 0600
 * files. The umask is narrowed while SQLite creates the WAL/SHM files.
 */
export function openOutbox(dir, { nowMs = Date.now() } = {}) {
  ensurePrivateDir(dir)
  const dbPath = outboxPath(dir)
  const previousUmask = process.umask(0o077)
  let db
  try {
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, nowMs)
  } catch (error) {
    db?.close()
    throw error
  } finally {
    process.umask(previousUmask)
  }
  tightenFilePermissions(dbPath)
  return { db, dir, path: dbPath, epoch: getMeta(db, 'epoch') }
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
}

export function getControl(db, key, fallback = null) {
  return db.prepare('SELECT value FROM runtime_control WHERE key = ?').get(key)?.value ?? fallback
}

export function setControl(db, key, value, nowMs = Date.now()) {
  db.prepare(
    `INSERT INTO runtime_control (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value), nowMs)
}

export function isCollectorEnabled(db) {
  return getControl(db, 'collector_enabled', '1') === '1'
}

export function isSenderEnabled(db) {
  return getControl(db, 'sender_enabled', '1') === '1'
}

/** Records each distinct config revision (configs never hold secrets, spec §17.3). */
export function recordConfigRevision(db, { revision, config }, loadedBy, nowMs = Date.now()) {
  db.prepare(
    'INSERT OR IGNORE INTO config_history (revision, first_loaded_at, loaded_by, config_json) VALUES (?, ?, ?, ?)'
  ).run(revision, nowMs, loadedBy, JSON.stringify(config))
}

/** Opens or increments the unresolved fault of `kind` so repeated failures stay one visible record. */
export function recordFault(db, { kind, detail = null, streamId = null }, nowMs = Date.now()) {
  const open = db
    .prepare('SELECT id FROM collection_faults WHERE kind = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(kind)
  if (open) {
    db.prepare('UPDATE collection_faults SET count = count + 1, last_at = ?, detail = ?, stream_id = COALESCE(?, stream_id) WHERE id = ?').run(
      nowMs,
      detail,
      streamId,
      open.id
    )
    return open.id
  }
  return Number(
    db
      .prepare('INSERT INTO collection_faults (kind, detail, stream_id, first_at, last_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, detail, streamId, nowMs, nowMs).lastInsertRowid
  )
}

export function resolveFaults(db, kinds, nowMs = Date.now()) {
  const placeholders = kinds.map(() => '?').join(', ')
  db.prepare(`UPDATE collection_faults SET resolved_at = ? WHERE resolved_at IS NULL AND kind IN (${placeholders})`).run(nowMs, ...kinds)
}

export function queueCounts(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM outbox_events GROUP BY status').all()
  const counts = Object.fromEntries(EVENT_STATUSES.map((status) => [status, 0]))
  for (const row of rows) counts[row.status] = row.n
  counts.undelivered = rows.filter((row) => row.status !== 'delivered').reduce((sum, row) => sum + row.n, 0)
  return counts
}
