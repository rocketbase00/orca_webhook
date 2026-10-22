import assert from 'node:assert/strict'
import http from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { postOnce } from '../lib/http-transport.mjs'
import { parseIngressConfig } from '../ingress/lib/ingress-config.mjs'
import { createIngress } from '../ingress/lib/ingress.mjs'
import { recordAgentStatus } from '../plugin/lib/collector-core.mjs'
import { parseConfig } from '../plugin/lib/config.mjs'
import { queueCounts, setControl, transaction } from '../plugin/lib/outbox-db.mjs'
import { signV2 } from '../plugin/lib/signing.mjs'
import { createSender } from '../sender/sender.mjs'
import { TEST_SECRET, createClock, makeConfig, openTestOutbox, pump, saveConfig, statusPayload, tempHome, writeSecretFile } from './helpers.mjs'

const ONLINE = () => ({ online: true, signature: 'test-net' })

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** Ingress + optional fake Hermes route, both on loopback. */
async function startStack(t, { clock, hooks, forward = false, ingressSecret = TEST_SECRET, epochs = ['*'] } = {}) {
  const home = tempHome(t)
  const hermesRequests = []
  let hermes = null
  if (forward) {
    hermes = await listen((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        hermesRequests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'accepted', delivery_id: req.headers['x-request-id'] }))
      })
    })
    t.after(() => hermes.server.close())
  }
  const config = parseIngressConfig({
    ingressConfigVersion: 1,
    listen: { host: '127.0.0.1', port: 1 },
    dataDir: join(home, 'ingress-data'),
    keys: [{ keyId: 'bridge-key-01', secretRef: `file:${writeSecretFile(home, 'ingress-secret.txt', ingressSecret)}` }],
    sources: [{ deviceId: 'macbook-air-01', keyIds: ['bridge-key-01'], epochs }],
    processing: forward
      ? { forward: { enabled: true, url: `http://127.0.0.1:${hermes.port}/webhooks/orca`, secretRef: `file:${writeSecretFile(home, 'hermes.txt', 'h'.repeat(40))}`, states: ['waiting', 'done'], historicalAfterSeconds: 600 } }
      : {}
  })
  const ingress = createIngress({ config, now: clock.now, hooks })
  const { server, port } = await listen((req, res) => void ingress.handleRequest(req, res))
  t.after(async () => {
    server.close()
    await ingress.stop()
  })
  return { ingress, port, hermesRequests, url: `http://127.0.0.1:${port}/bridge/v1/events`, config }
}

function setupSender(t, { clock, url, patch = {}, transport = postOnce, networkProbe = ONLINE }) {
  const home = tempHome(t)
  const raw = makeConfig(home, { endpointUrl: url, patch })
  saveConfig(home, raw)
  const config = parseConfig(raw)
  const outbox = openTestOutbox(home, config)
  t.after(() => outbox.db.close())
  const sender = createSender({ home, now: clock.now, transport, networkProbe, random: () => 0.5 })
  t.after(() => sender.close())
  return { home, config, raw, outbox, sender }
}

function record(outbox, config, overrides, nowMs) {
  return recordAgentStatus(outbox, { config, payload: statusPayload(overrides), nowMs })
}

function statusOf(outbox, eventId) {
  return outbox.db.prepare('SELECT * FROM outbox_events WHERE event_id = ?').get(eventId)
}

test('happy path: events are delivered in order, stored durably and projected (Phase 2 MVP)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  record(outbox, config, { state: 'working', receivedAt: 1 }, clock.now())
  record(outbox, config, { state: 'waiting', receivedAt: 2 }, clock.now())
  record(outbox, config, { paneKey: 'pane-b', state: 'done', receivedAt: 3 }, clock.now())
  await pump(sender, 6, clock)
  assert.equal(queueCounts(outbox.db).delivered, 4, 'three state events plus the sender_started lifecycle event')
  await stack.ingress.processPending()
  const inbox = stack.ingress.db.prepare('SELECT status FROM inbox').all()
  assert.equal(inbox.length, 4)
  assert.ok(inbox.every((row) => row.status === 'processed'))
  const streams = stack.ingress.db.prepare("SELECT * FROM stream_state WHERE kind = 'state_change' ORDER BY pane_key").all()
  assert.deepEqual(streams.map((s) => [s.pane_key, s.current_state, s.max_applied_sequence]), [
    ['pane-a', 'waiting', 2],
    ['pane-b', 'done', 1]
  ])
})

test('lost response: same event_id is resent, accepted once, processed once (A13)', async (t) => {
  const clock = createClock()
  let drop = 1
  const stack = await startStack(t, {
    clock,
    forward: true,
    hooks: {
      afterCommit(req, res, outcome, envelope) {
        if (outcome === 'accepted' && envelope.event_type === 'agent.status.changed' && drop > 0) {
          drop -= 1
          res.socket.destroy()
          return true
        }
        return false
      }
    }
  })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, eventId).status, 'retry_wait')
  clock.advance(10_000)
  await pump(sender, 3, clock)
  const row = statusOf(outbox, eventId)
  assert.equal(row.status, 'delivered')
  const attempts = outbox.db.prepare('SELECT outcome FROM delivery_attempts WHERE event_id = ? ORDER BY id').all(eventId).map((a) => a.outcome)
  assert.deepEqual(attempts, ['no_response', 'duplicate'])
  await stack.ingress.processPending()
  assert.equal(stack.ingress.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE event_id = ?').get(eventId).n, 1)
  const forwards = stack.hermesRequests.filter((r) => r.body.event_id === eventId)
  assert.equal(forwards.length, 1, 'Hermes is asked once')
  assert.equal(forwards[0].headers['x-request-id'], eventId)
  assert.match(forwards[0].body.summary, /agent waiting/)
})

test('same event_id with a different body is quarantined as 409 (A17)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, eventId).status, 'delivered')
  // Forge a different body under the same id and requeue it.
  const original = JSON.parse(Buffer.from(statusOf(outbox, eventId).body).toString('utf8'))
  original.data.state = 'done'
  original.data.normalized_state = 'done'
  outbox.db.prepare("UPDATE outbox_events SET body = ?, status = 'pending' WHERE event_id = ?").run(Buffer.from(JSON.stringify(original)), eventId)
  await pump(sender, 2, clock)
  const row = statusOf(outbox, eventId)
  assert.equal(row.status, 'dead_letter')
  assert.equal(row.dead_reason, 'conflict_409')
  assert.equal(stack.ingress.db.prepare('SELECT COUNT(*) AS n FROM conflicts').get().n, 1)
})

test('wrong key pauses the endpoint without dropping events; unknown key and stale timestamps are refused (A18, A21)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock, ingressSecret: 'f'.repeat(64) })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, eventId).status, 'blocked_config')
  const endpoint = outbox.db.prepare('SELECT * FROM endpoints').get()
  assert.equal(endpoint.paused_kind, 'auth')
  assert.match(endpoint.paused_reason, /bad_signature/)

  const body = Buffer.from('{}')
  const ts = Math.floor(clock.now() / 1000)
  const unknownKey = await postOnce(stack.url, {
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Key-Id': 'nope', 'X-Webhook-Timestamp': String(ts), 'X-Webhook-Signature-V2': signV2(TEST_SECRET, ts, body) },
    body,
    connectTimeoutMs: 2000,
    requestTimeoutMs: 5000
  })
  assert.equal(unknownKey.status, 401)
  const staleTs = ts - 3600
  const stale = await postOnce(stack.url, {
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Key-Id': 'bridge-key-01', 'X-Webhook-Timestamp': String(staleTs), 'X-Webhook-Signature-V2': signV2('f'.repeat(64), staleTs, body) },
    body,
    connectTimeoutMs: 2000,
    requestTimeoutMs: 5000
  })
  assert.equal(JSON.parse(stale.body).reason, 'timestamp_out_of_window')
})

test('an event saved hours ago is delivered with a fresh signature and unchanged observed_at (A19)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const threeHoursAgo = clock.now() - 3 * 3600_000
  const { eventId } = record(outbox, config, { state: 'waiting' }, threeHoursAgo)
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, eventId).status, 'delivered')
  const stored = stack.ingress.db.prepare('SELECT observed_at FROM inbox WHERE event_id = ?').get(eventId)
  assert.equal(stored.observed_at, new Date(threeHoursAgo).toISOString())
})

test('ordering: an older sequence never rolls the projected state back; other streams continue (A16)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const first = record(outbox, config, { state: 'working', receivedAt: 1 }, clock.now())
  const second = record(outbox, config, { state: 'waiting', receivedAt: 2 }, clock.now())
  // Deliver #2 first by parking #1 as a dead letter, then requeue #1.
  outbox.db.prepare("UPDATE outbox_events SET status = 'dead_letter' WHERE event_id = ?").run(first.eventId)
  record(outbox, config, { paneKey: 'pane-b', state: 'done', receivedAt: 3 }, clock.now())
  await pump(sender, 5, clock)
  assert.equal(statusOf(outbox, second.eventId).status, 'delivered')
  outbox.db.prepare("UPDATE outbox_events SET status = 'pending' WHERE event_id = ?").run(first.eventId)
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, first.eventId).status, 'delivered')
  await stack.ingress.processPending()
  const state = stack.ingress.db.prepare("SELECT * FROM stream_state WHERE pane_key = 'pane-a'").get()
  assert.equal(state.current_state, 'waiting')
  assert.equal(state.max_applied_sequence, 2)
  const late = stack.ingress.db.prepare('SELECT stale FROM inbox WHERE event_id = ?').get(first.eventId)
  assert.equal(late.stale, 1)
  const gap = stack.ingress.db.prepare('SELECT from_sequence, to_sequence FROM stream_gaps').get()
  assert.deepEqual({ ...gap }, { from_sequence: 1, to_sequence: 1 })
  assert.ok(stack.ingress.db.prepare("SELECT * FROM stream_state WHERE pane_key = 'pane-b'").get())
})

test('503 and 429 back off and recover; redirects are never followed (A21)', async (t) => {
  const clock = createClock()
  const responses = [
    { status: 503, body: '{}' },
    { status: 429, body: '{}', headers: { 'Retry-After': '120' } }
  ]
  let redirectHits = 0
  const { server, port } = await listen((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.url === '/target') redirectHits += 1
      const next = responses.shift()
      if (next) {
        res.writeHead(next.status, { 'Content-Type': 'application/json', ...(next.headers ?? {}) })
        res.end(next.body)
        return
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (envelope.event_type === 'bridge.lifecycle') {
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'accepted', event_id: envelope.event_id, durable: true }))
        return
      }
      res.writeHead(302, { Location: '/target' })
      res.end()
    })
  })
  t.after(() => server.close())
  const { config, outbox, sender } = setupSender(t, { clock, url: `http://127.0.0.1:${port}/bridge/v1/events` })
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  // Keep the sender_started lifecycle event from consuming the scripted responses first.
  sender.state.startedEmitted = true
  await pump(sender, 1, clock)
  let row = statusOf(outbox, eventId)
  assert.equal(row.status, 'retry_wait')
  assert.ok(row.next_attempt_at - clock.now() >= 3000)
  clock.advance(10_000)
  await pump(sender, 1, clock)
  row = statusOf(outbox, eventId)
  assert.equal(row.last_error, 'HTTP 429')
  assert.ok(row.next_attempt_at - clock.now() >= 110_000, 'Retry-After is honoured as a lower bound')
  // The long gap also counts as a resume, which queues (and sends first) a lifecycle event.
  clock.advance(130_000)
  await pump(sender, 3, clock)
  row = statusOf(outbox, eventId)
  assert.equal(row.status, 'blocked_config')
  assert.equal(redirectHits, 0)
  assert.equal(outbox.db.prepare('SELECT paused_kind FROM endpoints').get().paused_kind, 'redirect')
})

test('network down: attempts back off, offline skips without counting, recovery flushes the queue (A09, A10, A12)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  let down = true
  let online = true
  const transport = (url, options) => (down ? Promise.resolve({ kind: 'error', phase: 'connect', code: 'ECONNREFUSED', message: 'refused' }) : postOnce(url, options))
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url, transport, networkProbe: () => ({ online, signature: online ? 'net-a' : '' }) })
  const ids = [1, 2, 3].map((n) => record(outbox, config, { state: 'working', receivedAt: n }, clock.now()).eventId)
  await pump(sender, 3, clock)
  const attemptsWhileDown = outbox.db.prepare('SELECT COUNT(*) AS n FROM delivery_attempts').get().n
  assert.ok(attemptsWhileDown >= 1 && attemptsWhileDown <= 2, 'only a single probe goes out while unreachable')
  assert.equal(sender.state.reach, 'probing')

  online = false
  clock.advance(120_000)
  await pump(sender, 5, clock)
  assert.equal(outbox.db.prepare('SELECT COUNT(*) AS n FROM delivery_attempts').get().n, attemptsWhileDown, 'offline ticks do not count as attempts')

  online = true
  down = false
  await pump(sender, 8, clock)
  for (const id of ids) assert.equal(statusOf(outbox, id).status, 'delivered')
  assert.equal(sender.state.reach, 'up')
})

test('a resume gap triggers an immediate probe and a resume lifecycle event (A10)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  await pump(sender, 2, clock)
  record(outbox, config, { state: 'waiting' }, clock.now())
  clock.advance(2 * 3600_000)
  await pump(sender, 3, clock)
  const reasons = outbox.db
    .prepare("SELECT body FROM outbox_events WHERE event_type = 'bridge.lifecycle'")
    .all()
    .map((row) => JSON.parse(Buffer.from(row.body).toString('utf8')).data.reason)
  assert.ok(reasons.includes('resume_detected'))
  assert.equal(queueCounts(outbox.db).pending + queueCounts(outbox.db).retry_wait, 0)
})

test('a crashed attempt (expired lease) is reclaimed and resent with the same id (A08, A11)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  outbox.db.prepare("UPDATE outbox_events SET status = 'inflight', lease_owner = 'dead-sender', lease_expires_at = ? WHERE event_id = ?").run(clock.now() + 60_000, eventId)
  await pump(sender, 4, clock)
  assert.equal(statusOf(outbox, eventId).status, 'delivered')
  const outcomes = outbox.db.prepare('SELECT outcome FROM delivery_attempts WHERE event_id = ? ORDER BY id').all(eventId).map((r) => r.outcome)
  assert.equal(outcomes[0], 'outcome_unknown')
})

test('ingress restart mid-processing resumes from the inbox without re-forwarding (A14)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock, forward: true })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  record(outbox, config, { state: 'waiting' }, clock.now())
  record(outbox, config, { state: 'done', receivedAt: 2 }, clock.now())
  await pump(sender, 4, clock)
  await stack.ingress.processPending()
  assert.equal(stack.hermesRequests.length, 2)
  // Simulate a crash after the forward completed but before the row was marked processed.
  stack.ingress.db.prepare("UPDATE inbox SET status = 'processing' WHERE event_type = 'agent.status.changed'").run()
  const restarted = createIngress({ config: stack.config, now: clock.now })
  await restarted.processPending()
  await restarted.stop()
  assert.equal(stack.hermesRequests.length, 2, 'completed side effects are not reissued')
})

test('only state transitions are forwarded; a re-emitted unchanged state is stored but not forwarded', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock, forward: true })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const states = ['working', 'done', 'done', 'waiting', 'waiting', 'done']
  states.forEach((state, i) => record(outbox, config, { state, receivedAt: i + 1 }, clock.now()))
  await pump(sender, 10, clock)
  await stack.ingress.processPending()
  const inbox = stack.ingress.db.prepare("SELECT status FROM inbox WHERE event_type = 'agent.status.changed'").all()
  assert.equal(inbox.length, states.length)
  assert.ok(inbox.every((row) => row.status === 'processed'))
  assert.deepEqual(
    stack.hermesRequests.map((r) => [r.body.previous_state, r.body.state]),
    [
      ['working', 'done'],
      ['done', 'waiting'],
      ['waiting', 'done']
    ]
  )
})

test('dry run exercises URL and signing but never sends', async (t) => {
  const clock = createClock()
  let calls = 0
  const transport = () => {
    calls += 1
    return Promise.resolve({ kind: 'error', phase: 'connect', code: 'ECONNREFUSED' })
  }
  const { config, outbox, sender } = setupSender(t, { clock, url: 'http://127.0.0.1:9/bridge/v1/events', transport, patch: { mode: 'dry_run' } })
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  await pump(sender, 2, clock)
  assert.equal(calls, 0)
  const row = statusOf(outbox, eventId)
  assert.equal(row.status, 'dry_run')
  assert.ok(row.dry_run_checked_at)
  const attempt = outbox.db.prepare('SELECT * FROM delivery_attempts WHERE event_id = ?').get(eventId)
  assert.match(attempt.summary, /signature ok/)
})

test('bridge stop halts sending and keeps the queue (A25)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  transaction(outbox.db, () => {
    setControl(outbox.db, 'collector_enabled', '0')
    setControl(outbox.db, 'sender_enabled', '0')
  })
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, eventId).status, 'pending')
  transaction(outbox.db, () => {
    setControl(outbox.db, 'collector_enabled', '1')
    setControl(outbox.db, 'sender_enabled', '1')
  })
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, eventId).status, 'delivered')
})

test('a changed endpoint URL holds queued events until confirmed (§12.2)', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock })
  const { home, raw, config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  await pump(sender, 2, clock)
  transaction(outbox.db, () => setControl(outbox.db, 'sender_enabled', '0'))
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  raw.sender.endpointUrl = stack.url.replace('/bridge/v1/events', '/other/events')
  saveConfig(home, raw)
  transaction(outbox.db, () => setControl(outbox.db, 'sender_enabled', '1'))
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, eventId).status, 'pending')
  assert.equal(outbox.db.prepare('SELECT paused_kind FROM endpoints').get().paused_kind, 'url_changed')
})

test('ingress rejects unregistered epochs and mismatched X-Request-ID', async (t) => {
  const clock = createClock()
  const stack = await startStack(t, { clock, epochs: ['00000000-0000-4000-8000-000000000000'] })
  const { config, outbox, sender } = setupSender(t, { clock, url: stack.url })
  const { eventId } = record(outbox, config, { state: 'waiting' }, clock.now())
  await pump(sender, 3, clock)
  assert.equal(statusOf(outbox, eventId).status, 'blocked_config')
  assert.match(outbox.db.prepare('SELECT paused_reason FROM endpoints').get().paused_reason, /epoch_not_allowed/)

  const body = Buffer.from(statusOf(outbox, eventId).body)
  const ts = Math.floor(clock.now() / 1000)
  const mismatch = await postOnce(stack.url, {
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Key-Id': 'bridge-key-01',
      'X-Request-ID': 'other',
      'X-Webhook-Timestamp': String(ts),
      'X-Webhook-Signature-V2': signV2(TEST_SECRET, ts, body)
    },
    body,
    connectTimeoutMs: 2000,
    requestTimeoutMs: 5000
  })
  assert.equal(mismatch.status, 400)
})
