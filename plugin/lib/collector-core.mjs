import { randomUUID } from 'node:crypto'
import { statSync, statfsSync } from 'node:fs'
import { canonicalJson, sha256Hex } from './canonical-json.mjs'
import { buildEnvelope, deriveStreamId } from './envelope.mjs'
import { isInScope, normalizeState, parseAgentStatusPayload } from './normalize.mjs'
import { isCollectorEnabled, recordFault, resolveFaults, setControl, transaction } from './outbox-db.mjs'
import { PLUGIN_VERSION } from './version.mjs'

// Collector write path (spec §8.2, §9.1). Everything for one observation —
// sequence allocation, previous-state update, fingerprint, outbox row — is a
// single transaction, so a crash can never leave "sequence advanced but no
// event" or "state updated but no event".

const OBSERVED_TARGET_LIMIT = 500
const CAPACITY_FAULTS = ['queue_full', 'disk_quota', 'disk_low', 'payload_too_large']

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Returns the reason the queue cannot take another event, or null (spec §8.4). */
export function checkCapacity(outbox, queue) {
  const { n: stored } = outbox.db.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE status <> 'delivered'").get()
  if (stored >= queue.maxUndeliveredEvents) {
    return { kind: 'queue_full', detail: `${stored} undelivered events (limit ${queue.maxUndeliveredEvents})` }
  }
  const bytes = fileSize(outbox.path) + fileSize(`${outbox.path}-wal`)
  if (bytes >= queue.maxDiskBytes) {
    return { kind: 'disk_quota', detail: `outbox uses ${bytes} bytes (limit ${queue.maxDiskBytes})` }
  }
  try {
    const fs = statfsSync(outbox.dir)
    const free = fs.bavail * fs.bsize
    if (free < queue.minFreeDiskBytes) {
      return { kind: 'disk_low', detail: `${free} bytes free (minimum ${queue.minFreeDiskBytes})` }
    }
  } catch {
    // statfs unsupported: rely on the size limits above.
  }
  return null
}

function markGap(db, streamId, nowMs) {
  db.prepare('UPDATE source_state SET gap_pending = 1, updated_at = ? WHERE stream_id = ?').run(nowMs, streamId)
}

function recordObservedTarget(db, { worktreeId, paneKey, inScope, state }, nowMs) {
  db.prepare(
    `INSERT INTO observed_targets (worktree_key, worktree_id, pane_key, in_scope, last_state, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (worktree_key, pane_key) DO UPDATE SET
       in_scope = excluded.in_scope, last_state = excluded.last_state,
       last_seen_at = excluded.last_seen_at, seen_count = seen_count + 1`
  ).run(worktreeId ?? '', worktreeId, paneKey, inScope ? 1 : 0, state, nowMs, nowMs)
  db.prepare(
    `DELETE FROM observed_targets WHERE rowid IN (
       SELECT rowid FROM observed_targets ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?)`
  ).run(OBSERVED_TARGET_LIMIT)
}

function loadOrCreateStream(db, { streamId, kind, deviceId, epoch, worktreeId, paneKey }, nowMs) {
  const existing = db.prepare('SELECT * FROM source_state WHERE stream_id = ?').get(streamId)
  if (existing) return existing
  db.prepare(
    `INSERT INTO source_state (stream_id, kind, device_id, epoch, worktree_id, pane_key, next_sequence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(streamId, kind, deviceId, epoch, worktreeId, paneKey, nowMs, nowMs)
  return db.prepare('SELECT * FROM source_state WHERE stream_id = ?').get(streamId)
}

/**
 * Appends one envelope to the outbox inside the caller's transaction.
 * Returns {eventId, sequence} or {fault} when the body exceeds the size cap.
 */
function appendEvent(outbox, { config, stream, eventType, context, buildData, nowMs, newId }) {
  const { db, epoch } = outbox
  const sequence = stream.next_sequence
  const eventId = newId()
  const envelope = buildEnvelope({
    eventId,
    eventType,
    observedAt: new Date(nowMs).toISOString(),
    source: { deviceId: config.source.deviceId, epoch, orcaVersion: null, pluginVersion: PLUGIN_VERSION },
    stream: { id: stream.stream_id, sequence },
    context,
    data: buildData(stream)
  })
  // The stored bytes are what gets signed and sent on every retry (spec §10.2).
  const body = Buffer.from(JSON.stringify(envelope), 'utf8')
  if (body.length > config.queue.maxPayloadBytes) {
    return { fault: { kind: 'payload_too_large', detail: `${body.length} bytes (limit ${config.queue.maxPayloadBytes})` } }
  }
  db.prepare(
    `INSERT INTO outbox_events (event_id, endpoint_id, stream_id, sequence, event_type, observed_at, body, body_sha256,
                                status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    eventId,
    config.sender.endpointId,
    stream.stream_id,
    sequence,
    eventType,
    nowMs,
    body,
    sha256Hex(body),
    config.mode === 'dry_run' ? 'dry_run' : 'pending',
    nowMs,
    nowMs
  )
  return { eventId, sequence, envelope }
}

/**
 * Records one `agent.status.changed` observation. Never contacts the
 * network: the handler returns as soon as the commit is durable (spec §8.3).
 */
export function recordAgentStatus(outbox, { config, payload, nowMs = Date.now(), newId = randomUUID }) {
  const { db, epoch } = outbox
  let parsed
  try {
    parsed = parseAgentStatusPayload(payload)
  } catch (error) {
    // Only the validation message is kept — never the payload itself.
    transaction(db, () => recordFault(db, { kind: 'invalid_payload', detail: error.message.slice(0, 300) }, nowMs))
    return { outcome: 'invalid', error: error.message }
  }
  const { worktreeId, paneKey, state, receivedAt, mainAgent } = parsed
  const deviceId = config.source.deviceId
  const streamId = deriveStreamId({ deviceId, epoch, kind: 'agent', worktreeId, paneKey })

  return transaction(db, () => {
    setControl(db, 'collector_last_seen_at', nowMs, nowMs)
    if (!config.enabled || !isCollectorEnabled(db)) {
      markGap(db, streamId, nowMs)
      return { outcome: 'stopped', streamId }
    }
    if (!config.collector.events.includes('agent.status.changed')) {
      markGap(db, streamId, nowMs)
      return { outcome: 'not_selected', streamId }
    }
    const inScope = isInScope(config.collector.scope, worktreeId, paneKey)
    recordObservedTarget(db, { worktreeId, paneKey, inScope, state }, nowMs)
    if (!inScope) {
      markGap(db, streamId, nowMs)
      return { outcome: 'out_of_scope', streamId }
    }

    // Exact redelivery of the same host event maps onto the stored event (spec §9.1).
    // `state` alone is never the key: working → waiting → working is three events.
    const fingerprint = sha256Hex(
      canonicalJson({ v: 1, deviceId, epoch, streamId, worktreeId, paneKey, state, receivedAt, mainAgent: mainAgent ?? null })
    )
    const duplicate = db.prepare('SELECT event_id FROM source_fingerprints WHERE fingerprint = ?').get(fingerprint)
    if (duplicate) return { outcome: 'duplicate', eventId: duplicate.event_id, streamId }

    const capacity = checkCapacity(outbox, config.queue)
    if (capacity) {
      recordFault(db, { ...capacity, streamId }, nowMs)
      markGap(db, streamId, nowMs)
      return { outcome: 'overflow', fault: capacity, streamId }
    }

    const stream = loadOrCreateStream(db, { streamId, kind: 'agent', deviceId, epoch, worktreeId, paneKey }, nowMs)
    const mainAgentOut =
      config.collector.includeMainAgent && mainAgent
        ? { state: mainAgent.state, ...(mainAgent.outcome !== undefined ? { outcome: mainAgent.outcome } : {}), stateStartedAt: mainAgent.stateStartedAt }
        : null
    const appended = appendEvent(outbox, {
      config,
      stream,
      eventType: 'agent.status.changed',
      context: {
        worktreeId,
        paneKey,
        provider: config.context.providerByPaneKey[paneKey] ?? null,
        linearIssue: config.context.linearIssueByStreamId[streamId] ?? null
      },
      buildData: (row) => ({
        // null after a collection gap: we do not know what happened in between.
        previous_state: row.gap_pending ? null : row.last_state,
        state,
        normalized_state: normalizeState(state),
        received_at_raw: receivedAt,
        main_agent: mainAgentOut,
        evidence: 'orca_plugin_event'
      }),
      nowMs,
      newId
    })
    if (appended.fault) {
      recordFault(db, { ...appended.fault, streamId }, nowMs)
      markGap(db, streamId, nowMs)
      return { outcome: 'too_large', fault: appended.fault, streamId }
    }
    db.prepare(
      `UPDATE source_state SET next_sequence = ?, last_state = ?, last_main_agent_json = ?, last_observed_at = ?,
              gap_pending = 0, updated_at = ? WHERE stream_id = ?`
    ).run(appended.sequence + 1, state, mainAgent ? JSON.stringify(mainAgent) : null, nowMs, nowMs, streamId)
    db.prepare('INSERT INTO source_fingerprints (fingerprint, event_id, created_at) VALUES (?, ?, ?)').run(fingerprint, appended.eventId, nowMs)
    setControl(db, 'collector_last_event_at', nowMs, nowMs)
    resolveFaults(db, CAPACITY_FAULTS, nowMs)
    return { outcome: 'recorded', eventId: appended.eventId, sequence: appended.sequence, streamId }
  })
}

/** Bridge-originated lifecycle event (spec §7.1). Never dressed up as an Orca event. */
export function recordLifecycle(outbox, { config, reason, detail = {}, nowMs = Date.now(), newId = randomUUID }) {
  const { db, epoch } = outbox
  const deviceId = config.source.deviceId
  const streamId = deriveStreamId({ deviceId, epoch, kind: 'lifecycle' })
  return transaction(db, () => {
    const capacity = checkCapacity(outbox, config.queue)
    if (capacity) {
      recordFault(db, { ...capacity, streamId }, nowMs)
      return { outcome: 'overflow', fault: capacity }
    }
    const stream = loadOrCreateStream(db, { streamId, kind: 'lifecycle', deviceId, epoch, worktreeId: null, paneKey: null }, nowMs)
    const appended = appendEvent(outbox, {
      config,
      stream,
      eventType: 'bridge.lifecycle',
      context: {},
      buildData: () => ({ reason, detail }),
      nowMs,
      newId
    })
    if (appended.fault) {
      recordFault(db, { ...appended.fault, streamId }, nowMs)
      return { outcome: 'too_large', fault: appended.fault }
    }
    db.prepare('UPDATE source_state SET next_sequence = ?, last_state = ?, last_observed_at = ?, updated_at = ? WHERE stream_id = ?').run(
      appended.sequence + 1,
      reason,
      nowMs,
      nowMs,
      streamId
    )
    return { outcome: 'recorded', eventId: appended.eventId, sequence: appended.sequence, streamId }
  })
}
