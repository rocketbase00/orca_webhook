import { randomUUID } from 'node:crypto'
import { homedir, networkInterfaces } from 'node:os'
import { postOnce } from '../lib/http-transport.mjs'
import { SecretUnavailableError, resolveSecretRef } from '../lib/secret-ref.mjs'
import { recordLifecycle } from '../plugin/lib/collector-core.mjs'
import { createConfigCache } from '../plugin/lib/config.mjs'
import {
  getControl,
  isCollectorEnabled,
  isSenderEnabled,
  openOutbox,
  queueCounts,
  recordConfigRevision,
  setControl,
  transaction
} from '../plugin/lib/outbox-db.mjs'
import { configPath, resolveDirectoryRef } from '../plugin/lib/paths.mjs'
import { signV2 } from '../plugin/lib/signing.mjs'
import { PLUGIN_VERSION } from '../plugin/lib/version.mjs'
import { PAUSE_RECHECK_MS, classifyAttempt, retryDelayMs } from './classify.mjs'

// Sender: drains the outbox to one configured endpoint (spec §10, §12, §13).
// One event per stream at a time, at-least-once, same event_id and bytes on
// every retry, a fresh signature per attempt. tick() never blocks on HTTP:
// sends run in the background and drain() waits for them (tests, shutdown).

export const TICK_MS = 1000
const RESUME_GAP_MS = 15_000
const LOCK_TTL_MS = 30_000
const SECRET_CACHE_MS = 5 * 60_000
const CLEANUP_INTERVAL_MS = 60 * 60_000
const FAULT_REPORT_INTERVAL_MS = 60 * 60_000
const DAY_MS = 86_400_000
const AUTO_UNPAUSE_KINDS = ['auth', 'tls', 'route', 'redirect', 'secret_unavailable']
const ACTIVE_STATUSES = "('pending', 'retry_wait', 'inflight', 'blocked_config')"

/** Online when any non-loopback, non-link-local address exists. The signature detects network changes. */
export function defaultNetworkProbe() {
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.address.startsWith('fe80:') || entry.address.startsWith('169.254.')) continue
      addresses.push(entry.address)
    }
  }
  return { online: addresses.length > 0, signature: addresses.sort().join(',') }
}

export function heartbeatUrl(endpointUrl) {
  return new URL('heartbeat', endpointUrl).toString()
}

export function createSender({
  home = homedir(),
  now = () => Date.now(),
  transport = postOnce,
  resolveSecret = (ref) => resolveSecretRef(ref),
  networkProbe = defaultNetworkProbe,
  random = Math.random,
  log = { info() {}, warn() {}, error() {} },
  instanceId = randomUUID()
} = {}) {
  const configCache = createConfigCache(configPath(home))
  const inflight = new Map()
  const inflightStreams = new Set()
  const background = new Set()
  const state = {
    startedAt: now(),
    lastTickAt: null,
    reach: 'probing',
    nextProbeAt: 0,
    probeFailures: 0,
    tokens: 0,
    tokensAt: 0,
    secret: null,
    revision: null,
    configError: null,
    lastHeartbeatAt: 0,
    lastCleanupAt: 0,
    netSignature: null,
    startedEmitted: false,
    lockHeld: false
  }
  let outbox = null

  function track(promise) {
    background.add(promise)
    promise.finally(() => background.delete(promise))
    return promise
  }

  function ensureOutbox(loaded) {
    const dir = resolveDirectoryRef(loaded.config.queue.directoryRef, home)
    if (outbox && outbox.dir !== dir) {
      outbox.db.close()
      outbox = null
      state.lockHeld = false
    }
    if (!outbox) outbox = openOutbox(dir, { nowMs: now() })
    return outbox
  }

  /** Single-Sender guard; a newly acquired lock means any `inflight` row is an orphan. */
  function acquireLock(db, t) {
    return transaction(db, () => {
      const owner = getControl(db, 'sender_lock_owner')
      const expires = Number(getControl(db, 'sender_lock_expires_at', 0))
      if (owner && owner !== instanceId && expires > t) return false
      if (owner !== instanceId || !state.lockHeld) reclaimLeases(db, t, { all: true })
      setControl(db, 'sender_lock_owner', instanceId, t)
      setControl(db, 'sender_lock_expires_at', t + LOCK_TTL_MS, t)
      setControl(db, 'sender_heartbeat_at', t, t)
      setControl(db, 'sender_started_at', state.startedAt, t)
      return true
    })
  }

  /** Expired (or orphaned) attempts go back to retry: the receiver may already have them (spec §8.4). */
  function reclaimLeases(db, t, { all = false } = {}) {
    const rows = db
      .prepare(`SELECT event_id, endpoint_id, attempts FROM outbox_events WHERE status = 'inflight' AND (? OR lease_expires_at < ?)`)
      .all(all ? 1 : 0, t)
    for (const row of rows) {
      db.prepare(
        `INSERT INTO delivery_attempts (event_id, endpoint_id, attempt, started_at, finished_at, outcome, summary)
         VALUES (?, ?, ?, ?, ?, 'outcome_unknown', 'lease reclaimed; the receiver may already have this event')`
      ).run(row.event_id, row.endpoint_id, row.attempts, t, t)
      db.prepare(
        `UPDATE outbox_events SET status = 'retry_wait', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                last_error = 'attempt outcome unknown (lease reclaimed)', last_error_class = 'network', updated_at = ?
         WHERE event_id = ? AND status = 'inflight'`
      ).run(t, t, row.event_id)
    }
    return rows.length
  }

  function getEndpoint(db, endpointId) {
    return db.prepare('SELECT * FROM endpoints WHERE endpoint_id = ?').get(endpointId)
  }

  function activeCount(db, endpointId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM outbox_events WHERE endpoint_id = ? AND status IN ${ACTIVE_STATUSES}`).get(endpointId).n
  }

  /** A changed URL never silently inherits queued events (spec §12.2): it waits for `owb endpoint confirm`. */
  function syncEndpoint(db, config, t) {
    const { endpointId, endpointUrl } = config.sender
    transaction(db, () => {
      const row = getEndpoint(db, endpointId)
      if (!row) {
        db.prepare('INSERT INTO endpoints (endpoint_id, url, created_at, updated_at) VALUES (?, ?, ?, ?)').run(endpointId, endpointUrl, t, t)
        return
      }
      if (row.url === endpointUrl) {
        if (row.paused_kind === 'url_changed') {
          db.prepare('UPDATE endpoints SET paused_kind = NULL, paused_reason = NULL, pending_url = NULL, updated_at = ? WHERE endpoint_id = ?').run(t, endpointId)
        }
        return
      }
      if (activeCount(db, endpointId) === 0) {
        db.prepare('UPDATE endpoints SET url = ?, pending_url = NULL, updated_at = ? WHERE endpoint_id = ?').run(endpointUrl, t, endpointId)
        if (row.paused_kind === 'url_changed') unpause(db, endpointId, t)
        return
      }
      if (row.paused_kind !== 'url_changed' || row.pending_url !== endpointUrl) {
        db.prepare(
          `UPDATE endpoints SET paused_kind = 'url_changed', pending_url = ?, paused_reason = ?, paused_at = ?, recheck_at = NULL, updated_at = ?
           WHERE endpoint_id = ?`
        ).run(endpointUrl, 'endpoint URL changed; run "owb endpoint confirm" to move queued events to the new URL', t, t, endpointId)
        log.warn(`endpoint ${endpointId}: URL changed with queued events; waiting for "owb endpoint confirm"`)
      }
    })
  }

  function pause(db, endpointId, kind, reason, t) {
    const recheck = PAUSE_RECHECK_MS[kind] ? t + PAUSE_RECHECK_MS[kind] : null
    db.prepare(
      'UPDATE endpoints SET paused_kind = ?, paused_reason = ?, paused_at = ?, recheck_at = ?, updated_at = ? WHERE endpoint_id = ?'
    ).run(kind, reason.slice(0, 300), t, recheck, t, endpointId)
  }

  function unpause(db, endpointId, t) {
    db.prepare(
      'UPDATE endpoints SET paused_kind = NULL, paused_reason = NULL, paused_at = NULL, recheck_at = NULL, updated_at = ? WHERE endpoint_id = ?'
    ).run(t, endpointId)
    db.prepare("UPDATE outbox_events SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE endpoint_id = ? AND status = 'blocked_config'").run(
      t,
      t,
      endpointId
    )
    state.reach = 'probing'
    state.nextProbeAt = t
  }

  function onConfigRevision(db, loaded, t) {
    transaction(db, () => {
      recordConfigRevision(db, loaded, 'sender', t)
      setControl(db, 'config_revision', loaded.revision, t)
      // A config edit (or a Sender restart) may have fixed the cause: retry with a single probe.
      const row = getEndpoint(db, loaded.config.sender.endpointId)
      if (row && AUTO_UNPAUSE_KINDS.includes(row.paused_kind)) unpause(db, row.endpoint_id, t)
    })
    state.revision = loaded.revision
    state.secret = null
  }

  /** Events that only waited on connectivity become due now; the probe gate still lets one through first. */
  function releaseNetworkWaits(db, endpointId, t) {
    db.prepare(
      "UPDATE outbox_events SET next_attempt_at = ? WHERE endpoint_id = ? AND status = 'retry_wait' AND last_error_class = 'network' AND next_attempt_at > ?"
    ).run(t, endpointId, t)
  }

  function onResume(box, config, t, gapMs) {
    log.info(`resume detected after ${Math.round(gapMs / 1000)}s without ticks`)
    state.reach = 'probing'
    state.nextProbeAt = t
    state.secret = null
    releaseNetworkWaits(box.db, config.sender.endpointId, t)
    if (bridgeActive(box.db, config)) {
      recordLifecycle(box, { config, reason: 'resume_detected', detail: { gap_seconds: Math.round(gapMs / 1000) }, nowMs: t })
    }
  }

  function bridgeActive(db, config) {
    return config.enabled && isSenderEnabled(db) && isCollectorEnabled(db)
  }

  /** Collection faults become lifecycle events so the receiver learns about gaps (spec §7.1). */
  function reportFaults(box, config, t) {
    const rows = box.db
      .prepare(
        `SELECT * FROM collection_faults
         WHERE reported_at IS NULL OR (last_at > reported_at AND reported_at < ?) ORDER BY id LIMIT 20`
      )
      .all(t - FAULT_REPORT_INTERVAL_MS)
    for (const row of rows) {
      const result = recordLifecycle(box, {
        config,
        reason: 'collection_fault',
        detail: { fault: row.kind, count: row.count, first_at: new Date(row.first_at).toISOString(), last_at: new Date(row.last_at).toISOString(), resolved: row.resolved_at !== null, detail: row.detail },
        nowMs: t
      })
      if (result.outcome !== 'recorded') break
      box.db.prepare('UPDATE collection_faults SET reported_at = ? WHERE id = ?').run(t, row.id)
    }
  }

  function expireOldEvents(db, config, t) {
    const cutoff = t - config.sender.retry.maxEventAgeDays * DAY_MS
    const result = db
      .prepare(
        `UPDATE outbox_events SET status = 'dead_letter', dead_reason = 'expired', updated_at = ?
         WHERE status IN ('pending', 'retry_wait', 'blocked_config') AND expiry_override = 0 AND observed_at < ?`
      )
      .run(t, cutoff)
    if (result.changes > 0) log.warn(`${result.changes} event(s) older than ${config.sender.retry.maxEventAgeDays} days moved to dead letter (kept for review)`)
  }

  function cleanup(db, config, t) {
    const delivered = t - config.queue.deliveredRetentionDays * DAY_MS
    const attempts = t - config.queue.attemptLogRetentionDays * DAY_MS
    transaction(db, () => {
      db.prepare("DELETE FROM outbox_events WHERE status = 'delivered' AND delivered_at < ?").run(delivered)
      db.prepare("DELETE FROM outbox_events WHERE status = 'dry_run' AND dry_run_checked_at IS NOT NULL AND created_at < ?").run(delivered)
      db.prepare('DELETE FROM source_fingerprints WHERE created_at < ?').run(delivered)
      db.prepare('DELETE FROM delivery_attempts WHERE started_at < ?').run(attempts)
      db.prepare('DELETE FROM collection_faults WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(attempts)
      db.prepare('DELETE FROM observed_targets WHERE last_seen_at < ?').run(attempts)
    })
    state.lastCleanupAt = t
  }

  async function getSecret(ref, t) {
    if (state.secret && state.secret.ref === ref && t - state.secret.at < SECRET_CACHE_MS) return state.secret.value
    const value = await resolveSecret(ref)
    state.secret = { ref, value, at: t }
    return value
  }

  function takeToken(config, t) {
    const rate = config.sender.maxRequestsPerSecond
    const capacity = Math.max(1, rate)
    state.tokens = Math.min(capacity, state.tokens + ((t - state.tokensAt) / 1000) * rate)
    state.tokensAt = t
    if (state.tokens < 1) return false
    state.tokens -= 1
    return true
  }

  /** Dry run: everything except the POST — URL, signing secret and payload size are exercised (spec §17.3). */
  async function dryRunCheck(box, config, t) {
    const rows = box.db
      .prepare("SELECT event_id, endpoint_id, body FROM outbox_events WHERE status = 'dry_run' AND dry_run_checked_at IS NULL ORDER BY created_at LIMIT 50")
      .all()
    if (rows.length === 0) return
    let signing = 'signature ok'
    try {
      const secret = await getSecret(config.sender.signing.secretRef, t)
      signV2(secret, Math.floor(t / 1000), Buffer.from(rows[0].body))
    } catch (error) {
      signing = `signing secret unavailable (${error.code ?? error.message})`
      log.warn(`dry run: ${signing}`)
    }
    transaction(box.db, () => {
      for (const row of rows) {
        const target = row.endpoint_id === config.sender.endpointId ? config.sender.endpointUrl : `endpoint ${row.endpoint_id} (not the configured one)`
        box.db
          .prepare(
            `INSERT INTO delivery_attempts (event_id, endpoint_id, attempt, started_at, finished_at, outcome, summary, request_id)
             VALUES (?, ?, 0, ?, ?, 'dry_run', ?, ?)`
          )
          .run(row.event_id, row.endpoint_id, t, t, `would POST ${row.body.length} bytes to ${target}; ${signing}`, row.event_id)
        box.db.prepare('UPDATE outbox_events SET dry_run_checked_at = ?, updated_at = ? WHERE event_id = ?').run(t, t, row.event_id)
      }
    })
  }

  /** Head of each stream = lowest undelivered sequence; dead letters do not block their stream (spec §9.2). */
  function selectHeads(db, endpointId, t, limit) {
    return db
      .prepare(
        `SELECT e.* FROM outbox_events e
         JOIN (SELECT stream_id, MIN(sequence) AS seq FROM outbox_events
               WHERE endpoint_id = ? AND status IN ('pending', 'retry_wait', 'inflight', 'blocked_config') GROUP BY stream_id) h
           ON e.stream_id = h.stream_id AND e.sequence = h.seq
         WHERE e.status IN ('pending', 'retry_wait') AND e.next_attempt_at <= ?
         ORDER BY e.next_attempt_at, e.created_at
         LIMIT ?`
      )
      .all(endpointId, t, limit)
  }

  function probeDelayMs(config) {
    return Math.min(5000 * 2 ** Math.max(0, state.probeFailures - 1), config.sender.resumeCheckIntervalSeconds * 1000)
  }

  async function sendOne(box, config, row) {
    const { db } = box
    const { endpointId, endpointUrl, signing, responseContract } = config.sender
    const leasedAt = now()
    const leased = db
      .prepare(
        `UPDATE outbox_events SET status = 'inflight', lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE event_id = ? AND status IN ('pending', 'retry_wait')`
      )
      .run(instanceId, leasedAt + config.sender.requestTimeoutSeconds * 1000 + 30_000, leasedAt, row.event_id)
    if (leased.changes !== 1) return

    let secret
    try {
      secret = await getSecret(signing.secretRef, leasedAt)
    } catch (error) {
      // Not an attempt: nothing was sent (spec §12.1). Hold sending, never fall back to unsigned.
      const t = now()
      const code = error instanceof SecretUnavailableError ? error.code : 'error'
      transaction(db, () => {
        db.prepare(
          `UPDATE outbox_events SET status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE event_id = ? AND status = 'inflight'`
        ).run(row.status, `signing secret unavailable (${code})`, t, row.event_id)
        pause(db, endpointId, 'secret_unavailable', `signing secret unavailable (${code})`, t)
      })
      log.warn(`signing secret unavailable (${code}); sending held`)
      return
    }

    const attempt = row.attempts + 1
    const body = Buffer.from(row.body)
    const startedAt = now()
    const timestamp = Math.floor(startedAt / 1000)
    const result = await transport(endpointUrl, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': `orca-webhook-bridge/${PLUGIN_VERSION}`,
        'X-Request-ID': row.event_id,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Signature-V2': signV2(secret, timestamp, body),
        'X-Bridge-Key-Id': signing.keyId,
        'X-Bridge-Attempt': String(attempt)
      },
      body,
      connectTimeoutMs: config.sender.connectTimeoutSeconds * 1000,
      requestTimeoutMs: config.sender.requestTimeoutSeconds * 1000
    })
    const t = now()
    const verdict = classifyAttempt(result, { eventId: row.event_id, contract: responseContract, nowMs: t })

    transaction(db, () => {
      db.prepare(
        `INSERT INTO delivery_attempts (event_id, endpoint_id, attempt, started_at, finished_at, outcome, http_status, summary, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(row.event_id, endpointId, attempt, startedAt, t, verdict.outcome, result.kind === 'response' ? result.status : null, verdict.summary.slice(0, 300), row.event_id)
      const common = [attempt, verdict.summary.slice(0, 300), t, row.event_id]
      if (verdict.status === 'delivered') {
        db.prepare(
          `UPDATE outbox_events SET status = 'delivered', delivered_at = ?, attempts = ?, last_error = NULL, last_error_class = NULL,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE event_id = ?`
        ).run(t, attempt, t, row.event_id)
        db.prepare('UPDATE endpoints SET last_success_at = ?, updated_at = ? WHERE endpoint_id = ?').run(t, t, endpointId)
        setControl(db, 'last_delivered_at', t, t)
        return
      }
      if (verdict.status === 'retry_wait') {
        const delay = Math.max(retryDelayMs(attempt, config.sender.retry, random), verdict.minDelayMs)
        db.prepare(
          `UPDATE outbox_events SET status = 'retry_wait', attempts = ?, last_error = ?, last_error_class = ?, next_attempt_at = ?,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE event_id = ?`
        ).run(attempt, verdict.summary.slice(0, 300), verdict.errorClass, t + delay, t, row.event_id)
      } else if (verdict.status === 'blocked_config') {
        db.prepare(
          `UPDATE outbox_events SET status = 'blocked_config', attempts = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE event_id = ?`
        ).run(...common)
        pause(db, endpointId, verdict.pause.kind, verdict.pause.reason, t)
      } else if (verdict.status === 'dead_letter') {
        db.prepare(
          `UPDATE outbox_events SET status = 'dead_letter', dead_reason = ?, attempts = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = ? WHERE event_id = ?`
        ).run(verdict.deadReason, ...common)
      }
      db.prepare('UPDATE endpoints SET last_failure_at = ?, last_error = ?, updated_at = ? WHERE endpoint_id = ?').run(t, verdict.summary.slice(0, 300), t, endpointId)
    })

    if (verdict.pause) {
      log.warn(`endpoint ${endpointId} paused (${verdict.pause.kind}): ${verdict.pause.reason}`)
      if (verdict.pause.kind === 'auth') state.secret = null
    } else if (verdict.status === 'dead_letter') {
      log.warn(`event ${row.event_id} moved to dead letter: ${verdict.summary}`)
    }
    noteReachability(db, config, verdict.reachable, t, verdict.summary)
  }

  /** Any HTTP answer proves reachability; a failed connection switches to one-at-a-time probing with backoff. */
  function noteReachability(db, config, reachable, t, summary) {
    const { endpointId } = config.sender
    if (reachable === true && state.reach !== 'up') {
      // Recovered: let events that waited on the network go now, still paced by the rate limit (spec §12.1).
      state.reach = 'up'
      state.probeFailures = 0
      releaseNetworkWaits(db, endpointId, t)
      log.info(`endpoint ${endpointId} reachable`)
    } else if (reachable === false) {
      if (state.reach === 'up') log.warn(`endpoint ${endpointId} unreachable (${summary}); probing with backoff`)
      state.reach = 'probing'
      state.probeFailures += 1
      state.nextProbeAt = t + probeDelayMs(config)
    }
  }

  /** Returns how many sends were started. */
  function dispatch(box, config, t) {
    const probing = state.reach !== 'up'
    if (probing && (inflight.size > 0 || t < state.nextProbeAt)) return 0
    const maxConcurrent = probing ? 1 : config.sender.maxConcurrentRequests
    let available = maxConcurrent - inflight.size
    if (available <= 0) return 0
    let started = 0
    const rows = selectHeads(box.db, config.sender.endpointId, t, available + inflightStreams.size + 4)
    for (const row of rows) {
      if (available <= 0) break
      if (inflightStreams.has(row.stream_id) || inflight.has(row.event_id)) continue
      if (!takeToken(config, t)) break
      available -= 1
      started += 1
      inflightStreams.add(row.stream_id)
      const promise = sendOne(box, config, row)
        .catch((error) => log.error(`send ${row.event_id} failed unexpectedly: ${error.stack ?? error.message}`))
        .finally(() => {
          inflight.delete(row.event_id)
          inflightStreams.delete(row.stream_id)
        })
      inflight.set(row.event_id, promise)
      track(promise)
    }
    return started
  }

  /**
   * Optional health path (spec §13.3), separate from the event queue and
   * never dressed up as an Orca event. With an empty queue it also serves
   * as the reachability probe.
   */
  async function sendHeartbeat(box, config, t) {
    const { db } = box
    const counts = queueCounts(db)
    const oldest = db.prepare(`SELECT MIN(observed_at) AS t FROM outbox_events WHERE status IN ${ACTIVE_STATUSES}`).get().t
    const body = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        kind: 'heartbeat',
        device_id: config.source.deviceId,
        epoch: box.epoch,
        sent_at: new Date(t).toISOString(),
        mode: config.mode,
        sender: { instance_id: instanceId, started_at: new Date(state.startedAt).toISOString(), plugin_version: PLUGIN_VERSION },
        collector: {
          enabled: isCollectorEnabled(db),
          last_event_at: isoOrNull(getControl(db, 'collector_last_event_at')),
          last_seen_at: isoOrNull(getControl(db, 'collector_last_seen_at'))
        },
        queue: {
          undelivered: counts.pending + counts.retry_wait + counts.inflight + counts.blocked_config,
          dead_letter: counts.dead_letter,
          oldest_undelivered_observed_at: oldest ? new Date(oldest).toISOString() : null
        }
      }),
      'utf8'
    )
    try {
      const secret = await getSecret(config.sender.signing.secretRef, t)
      const timestamp = Math.floor(now() / 1000)
      const result = await transport(heartbeatUrl(config.sender.endpointUrl), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': `orca-webhook-bridge/${PLUGIN_VERSION}`,
          'X-Request-ID': randomUUID(),
          'X-Webhook-Timestamp': String(timestamp),
          'X-Webhook-Signature-V2': signV2(secret, timestamp, body),
          'X-Bridge-Key-Id': config.sender.signing.keyId
        },
        body,
        connectTimeoutMs: config.sender.connectTimeoutSeconds * 1000,
        requestTimeoutMs: config.sender.requestTimeoutSeconds * 1000
      })
      if (result.kind !== 'response' || result.status !== 200) {
        log.warn(`heartbeat not accepted: ${result.kind === 'response' ? `HTTP ${result.status}` : result.code}`)
      }
      const reachable = result.kind === 'response' ? true : result.phase === 'connect' ? false : null
      noteReachability(db, config, reachable, now(), result.kind === 'response' ? `HTTP ${result.status}` : result.code)
    } catch (error) {
      log.warn(`heartbeat skipped: ${error.code ?? error.message}`)
    }
  }

  async function tick() {
    const t = now()
    const gap = state.lastTickAt === null ? 0 : t - state.lastTickAt
    state.lastTickAt = t

    const loaded = configCache.get()
    if (!loaded.ok) {
      if (state.configError !== loaded.error) log.error(`config: ${loaded.error}`)
      state.configError = loaded.error
      return 'config_error'
    }
    if (state.configError) log.info('config loaded')
    state.configError = null
    const { config } = loaded
    const box = ensureOutbox(loaded)
    const { db } = box

    if (!acquireLock(db, t)) {
      if (state.lockHeld) log.warn('another Sender holds the outbox lock; standing by')
      state.lockHeld = false
      return 'locked'
    }
    state.lockHeld = true
    if (state.revision !== loaded.revision) onConfigRevision(db, loaded, t)
    syncEndpoint(db, config, t)
    transaction(db, () => reclaimLeases(db, t))
    if (gap > RESUME_GAP_MS) onResume(box, config, t, gap)
    if (t - state.lastCleanupAt > CLEANUP_INTERVAL_MS) cleanup(db, config, t)
    if (!bridgeActive(db, config)) return 'stopped'
    if (!state.startedEmitted) {
      state.startedEmitted = true
      recordLifecycle(box, { config, reason: 'sender_started', detail: { plugin_version: PLUGIN_VERSION }, nowMs: t })
    }
    reportFaults(box, config, t)
    expireOldEvents(db, config, t)

    if (config.mode === 'dry_run') {
      await dryRunCheck(box, config, t)
      return 'dry_run'
    }

    const net = networkProbe()
    if (state.netSignature !== null && net.signature !== state.netSignature) {
      log.info('network change detected; probing endpoint')
      state.reach = 'probing'
      state.nextProbeAt = t
      releaseNetworkWaits(db, config.sender.endpointId, t)
    }
    state.netSignature = net.signature
    // Offline: skip without counting an attempt (spec §12.1, §13.1).
    if (!net.online) return 'offline'

    const endpoint = getEndpoint(db, config.sender.endpointId)
    if (endpoint.paused_kind) {
      if (endpoint.recheck_at === null || endpoint.recheck_at > t || inflight.size > 0) return 'paused'
      transaction(db, () => unpause(db, endpoint.endpoint_id, t))
      log.info(`endpoint ${endpoint.endpoint_id}: re-checking after ${endpoint.paused_kind} pause`)
    }

    const started = dispatch(box, config, t)

    const hb = config.sender.heartbeat
    const heartbeatDue = t - state.lastHeartbeatAt >= hb.intervalSeconds * 1000
    const canProbe = started === 0 && inflight.size === 0 && t >= state.nextProbeAt
    if (hb.enabled && config.sender.responseContract === 'bridge_v1' && heartbeatDue && (state.reach === 'up' || canProbe)) {
      state.lastHeartbeatAt = t
      track(sendHeartbeat(box, config, t))
    }
    return 'active'
  }

  return {
    tick,
    state,
    instanceId,
    async drain() {
      while (background.size > 0) await Promise.allSettled([...background])
    },
    close() {
      if (outbox) {
        try {
          transaction(outbox.db, () => {
            if (getControl(outbox.db, 'sender_lock_owner') === instanceId) setControl(outbox.db, 'sender_lock_expires_at', 0)
          })
        } catch {
          // Best effort: the lock expires on its own.
        }
        outbox.db.close()
        outbox = null
      }
    }
  }
}

function isoOrNull(value) {
  const ms = Number(value)
  return ms > 0 ? new Date(ms).toISOString() : null
}
