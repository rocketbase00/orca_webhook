import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { test } from 'node:test'
import { checkCapacity, recordAgentStatus, recordLifecycle } from '../plugin/lib/collector-core.mjs'
import { parseConfig } from '../plugin/lib/config.mjs'
import { parseEnvelope } from '../plugin/lib/envelope.mjs'
import { queueCounts, setControl, transaction } from '../plugin/lib/outbox-db.mjs'
import { makeConfig, openTestOutbox, statusPayload, tempHome } from './helpers.mjs'

function setup(t, patch) {
  const home = tempHome(t)
  const config = parseConfig(makeConfig(home, { patch }))
  const outbox = openTestOutbox(home, config)
  t.after(() => outbox.db.close())
  return { home, config, outbox }
}

function bodies(outbox) {
  return outbox.db
    .prepare('SELECT body FROM outbox_events ORDER BY stream_id, sequence')
    .all()
    .map((row) => JSON.parse(Buffer.from(row.body).toString('utf8')))
}

test('outbox files are private (0700 dir, 0600 files) and the epoch is stable across reopen', (t) => {
  const { home, config, outbox } = setup(t)
  assert.equal(statSync(outbox.dir).mode & 0o777, 0o700)
  assert.equal(statSync(outbox.path).mode & 0o777, 0o600)
  const again = openTestOutbox(home, config)
  assert.equal(again.epoch, outbox.epoch)
  again.db.close()
})

test('records an in-scope event as a valid envelope with sequence 1 and previous_state null', (t) => {
  const { config, outbox } = setup(t)
  const result = recordAgentStatus(outbox, { config, payload: statusPayload() })
  assert.equal(result.outcome, 'recorded')
  assert.equal(result.sequence, 1)
  const [envelope] = bodies(outbox)
  assert.doesNotThrow(() => parseEnvelope(structuredClone(envelope)))
  assert.equal(envelope.event_type, 'agent.status.changed')
  assert.equal(envelope.source.device_id, 'macbook-air-01')
  assert.equal(envelope.source.epoch, outbox.epoch)
  assert.equal(envelope.source.orca_version, null)
  assert.equal(envelope.data.previous_state, null)
  assert.equal(envelope.data.normalized_state, 'working')
  assert.equal(envelope.data.received_at_raw, 1792544400000)
  assert.equal(envelope.data.evidence, 'orca_plugin_event')
  assert.equal(envelope.context.provider, null)
  assert.equal(queueCounts(outbox.db).pending, 1)
})

test('working → waiting → working are three events; exact redelivery is deduplicated (§9.1)', (t) => {
  const { config, outbox } = setup(t)
  const a = recordAgentStatus(outbox, { config, payload: statusPayload({ state: 'working', receivedAt: 1 }) })
  recordAgentStatus(outbox, { config, payload: statusPayload({ state: 'waiting', receivedAt: 2 }) })
  recordAgentStatus(outbox, { config, payload: statusPayload({ state: 'working', receivedAt: 3 }) })
  const dup = recordAgentStatus(outbox, { config, payload: statusPayload({ state: 'working', receivedAt: 1 }) })
  assert.equal(dup.outcome, 'duplicate')
  assert.equal(dup.eventId, a.eventId)
  const all = bodies(outbox)
  assert.deepEqual(all.map((e) => [e.stream.sequence, e.data.previous_state, e.data.state]), [
    [1, null, 'working'],
    [2, 'working', 'waiting'],
    [3, 'waiting', 'working']
  ])
})

test('a mainAgent-only change is its own event and mainAgent is copied selectively (A03, A04)', (t) => {
  const { config, outbox } = setup(t)
  recordAgentStatus(outbox, { config, payload: statusPayload({ mainAgent: { state: 'working', stateStartedAt: 10 } }) })
  const second = recordAgentStatus(outbox, {
    config,
    payload: statusPayload({ mainAgent: { state: 'done', outcome: 'interruption', stateStartedAt: 20, extra: 'not forwarded' } })
  })
  assert.equal(second.outcome, 'recorded')
  const all = bodies(outbox)
  assert.equal(all.length, 2)
  assert.deepEqual(all[1].data.main_agent, { state: 'done', outcome: 'interruption', stateStartedAt: 20 })
  assert.equal(all[1].data.state, 'working')
})

test('unknown states keep the raw value; null worktree works when allowed (A05)', (t) => {
  const { config, outbox } = setup(t)
  recordAgentStatus(outbox, { config, payload: statusPayload({ worktreeId: null, state: 'needs-approval' }) })
  const [envelope] = bodies(outbox)
  assert.equal(envelope.context.worktree_id, null)
  assert.equal(envelope.data.state, 'needs-approval')
  assert.equal(envelope.data.normalized_state, 'unknown')
})

test('out-of-scope events are not queued, only noted locally, and mark a gap (A01)', (t) => {
  const { config, outbox } = setup(t)
  recordAgentStatus(outbox, { config, payload: statusPayload({ state: 'working', receivedAt: 1 }) })
  const narrowed = parseConfig({ ...structuredClone(config), collector: { ...config.collector, scope: { worktreeIds: [], paneKeys: ['pane-b'], includeUnscoped: false } } })
  assert.equal(recordAgentStatus(outbox, { config: narrowed, payload: statusPayload({ state: 'waiting', receivedAt: 2 }) }).outcome, 'out_of_scope')
  assert.equal(recordAgentStatus(outbox, { config, payload: statusPayload({ state: 'done', receivedAt: 3 }) }).outcome, 'recorded')
  const all = bodies(outbox)
  assert.equal(all.length, 2)
  assert.equal(all[1].data.previous_state, null, 'previous_state is unknown after a collection gap')
  const target = outbox.db.prepare('SELECT * FROM observed_targets WHERE pane_key = ?').get('pane-a')
  assert.equal(target.seen_count, 3)
})

test('stopped bridge (config or runtime control) records nothing', (t) => {
  const { config, outbox } = setup(t)
  const disabled = { ...config, enabled: false }
  assert.equal(recordAgentStatus(outbox, { config: disabled, payload: statusPayload() }).outcome, 'stopped')
  transaction(outbox.db, () => setControl(outbox.db, 'collector_enabled', '0'))
  assert.equal(recordAgentStatus(outbox, { config, payload: statusPayload() }).outcome, 'stopped')
  assert.equal(queueCounts(outbox.db).undelivered, 0)
})

test('dry-run mode stores events as dry_run (never sent)', (t) => {
  const { config, outbox } = setup(t, { mode: 'dry_run' })
  recordAgentStatus(outbox, { config, payload: statusPayload() })
  assert.equal(queueCounts(outbox.db).dry_run, 1)
})

test('malformed payloads are rejected and recorded as a fault without the payload', (t) => {
  const { config, outbox } = setup(t)
  const result = recordAgentStatus(outbox, { config, payload: { paneKey: 'pane-a', state: '', receivedAt: -1, secret: 'x' } })
  assert.equal(result.outcome, 'invalid')
  const fault = outbox.db.prepare("SELECT * FROM collection_faults WHERE kind = 'invalid_payload'").get()
  assert.ok(fault)
  assert.ok(!fault.detail.includes('secret'))
})

test('queue full: no silent deletion, collection stops with a fault and a gap (A22)', (t) => {
  const { config, outbox } = setup(t, { queue: { maxUndeliveredEvents: 10 } })
  for (let index = 0; index < 10; index++) {
    assert.equal(recordAgentStatus(outbox, { config, payload: statusPayload({ receivedAt: index + 1 }) }).outcome, 'recorded')
  }
  const overflow = recordAgentStatus(outbox, { config, payload: statusPayload({ receivedAt: 100 }) })
  assert.equal(overflow.outcome, 'overflow')
  assert.equal(overflow.fault.kind, 'queue_full')
  assert.equal(queueCounts(outbox.db).undelivered, 10)
  const fault = outbox.db.prepare("SELECT * FROM collection_faults WHERE kind = 'queue_full'").get()
  assert.equal(fault.resolved_at, null)
  assert.equal(outbox.db.prepare('SELECT gap_pending FROM source_state').get().gap_pending, 1)
  assert.equal(recordLifecycle(outbox, { config, reason: 'manual_test' }).outcome, 'overflow')
})

test('payload size cap produces a fault instead of an oversized event', (t) => {
  const { config, outbox } = setup(t, { queue: { maxPayloadBytes: 1024 } })
  const result = recordAgentStatus(outbox, { config, payload: statusPayload({ paneKey: 'pane-a', worktreeId: 'w'.repeat(1500) }) })
  assert.equal(result.outcome, 'too_large')
  assert.equal(queueCounts(outbox.db).undelivered, 0)
})

test('disk quota check counts the WAL too', (t) => {
  const { config, outbox } = setup(t)
  assert.equal(checkCapacity(outbox, { ...config.queue, maxDiskBytes: 1 }).kind, 'disk_quota')
  assert.equal(checkCapacity(outbox, { ...config.queue, minFreeDiskBytes: Number.MAX_SAFE_INTEGER }).kind, 'disk_low')
})

test('a crash mid-transaction rolls back sequence, state and fingerprint together (A07)', (t) => {
  const { config, outbox } = setup(t)
  recordAgentStatus(outbox, { config, payload: statusPayload({ receivedAt: 1 }) })
  let calls = 0
  const crashingId = () => {
    calls += 1
    // Fails after the stream row exists, before the outbox insert.
    throw new Error('simulated crash')
  }
  assert.throws(() => recordAgentStatus(outbox, { config, payload: statusPayload({ receivedAt: 2, state: 'waiting' }), newId: crashingId }), /simulated crash/)
  assert.equal(calls, 1)
  const stream = outbox.db.prepare('SELECT next_sequence, last_state FROM source_state').get()
  assert.deepEqual({ ...stream }, { next_sequence: 2, last_state: 'working' })
  assert.equal(outbox.db.prepare('SELECT COUNT(*) AS n FROM source_fingerprints').get().n, 1)
  // The retried observation then gets sequence 2 with a consistent previous_state.
  const retried = recordAgentStatus(outbox, { config, payload: statusPayload({ receivedAt: 2, state: 'waiting' }) })
  assert.equal(retried.sequence, 2)
  assert.equal(bodies(outbox)[1].data.previous_state, 'working')
})

test('provider and Linear issue are attached only from explicit config', (t) => {
  const { config, outbox } = setup(t)
  const first = recordAgentStatus(outbox, { config, payload: statusPayload({ receivedAt: 1 }) })
  const linked = parseConfig({
    ...structuredClone(config),
    context: {
      providerByPaneKey: { 'pane-a': 'codex' },
      linearIssueByStreamId: { [first.streamId]: { id: 'c357b0a8-8c73-4566-aafc-2b3408f21bf6', identifier: 'DEV-123' } }
    }
  })
  recordAgentStatus(outbox, { config: linked, payload: statusPayload({ receivedAt: 2 }) })
  const all = bodies(outbox)
  assert.equal(all[0].context.linear_issue, null)
  assert.equal(all[1].context.provider, 'codex')
  assert.equal(all[1].context.linear_issue.identifier, 'DEV-123')
})
