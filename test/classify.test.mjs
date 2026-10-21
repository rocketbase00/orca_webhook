import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyAttempt, parseRetryAfterMs, retryDelayMs } from '../sender/classify.mjs'

const eventId = 'ca387f71-5a2a-4d98-87c7-eed8bda116aa'
const response = (status, body, headers = {}) => ({ kind: 'response', status, headers, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) })
const classify = (result, contract = 'bridge_v1') => classifyAttempt(result, { eventId, contract, nowMs: 0 })

test('only the contracted durable success counts as delivered (A23)', () => {
  assert.equal(classify(response(202, { status: 'accepted', event_id: eventId, durable: true })).status, 'delivered')
  assert.equal(classify(response(200, { status: 'duplicate', event_id: eventId, durable: true })).outcome, 'duplicate')
  for (const bad of [
    response(202, { status: 'accepted', event_id: 'other', durable: true }),
    response(202, { status: 'accepted', event_id: eventId }),
    response(204, ''),
    response(200, '<html>proxy</html>'),
    response(200, { status: 'accepted', event_id: eventId, durable: true })
  ]) {
    const verdict = classify(bad)
    assert.equal(verdict.status, 'retry_wait')
    assert.equal(verdict.outcome, 'invalid_response')
    assert.ok(verdict.minDelayMs >= 300_000)
  }
})

test('Hermes built-in contract matches delivery_id', () => {
  assert.equal(classify(response(202, { status: 'accepted', delivery_id: eventId }), 'hermes_webhook').status, 'delivered')
  assert.equal(classify(response(200, { status: 'duplicate', delivery_id: eventId }), 'hermes_webhook').status, 'delivered')
  assert.equal(classify(response(202, { status: 'accepted', delivery_id: 'x' }), 'hermes_webhook').status, 'retry_wait')
})

test('error table from spec §12.2', () => {
  assert.equal(classify({ kind: 'error', phase: 'connect', code: 'ECONNREFUSED' }).reachable, false)
  assert.equal(classify({ kind: 'error', phase: 'sent', code: 'REQUEST_TIMEOUT' }).outcome, 'no_response')
  assert.equal(classify({ kind: 'error', phase: 'tls', code: 'CERT_HAS_EXPIRED' }).pause.kind, 'tls')
  assert.equal(classify(response(503, {})).status, 'retry_wait')
  assert.equal(classify(response(429, {}, { 'retry-after': '120' })).minDelayMs, 120_000)
  assert.equal(classify(response(408, {})).status, 'retry_wait')
  for (const status of [400, 413, 422]) assert.equal(classify(response(status, {})).status, 'dead_letter')
  assert.equal(classify(response(409, {})).deadReason, 'conflict_409')
  assert.equal(classify(response(401, {})).pause.kind, 'auth')
  assert.equal(classify(response(403, {})).status, 'blocked_config')
  assert.equal(classify(response(404, {})).pause.kind, 'route')
  assert.equal(classify(response(302, '')).pause.kind, 'redirect')
})

test('backoff grows roughly 5s, 15s, 45s ... and is capped', () => {
  const retry = { initialDelaySeconds: 5, maxDelaySeconds: 900, jitter: false }
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelayMs(n, retry)), [5000, 15000, 45000, 135000, 405000, 900000, 900000])
  const jittered = retryDelayMs(1, { ...retry, jitter: true }, () => 0)
  assert.equal(jittered, 3750)
})

test('Retry-After accepts seconds and HTTP dates, capped at one hour', () => {
  assert.equal(parseRetryAfterMs('30', 0), 30_000)
  assert.equal(parseRetryAfterMs('999999', 0), 3_600_000)
  assert.equal(parseRetryAfterMs(new Date(60_000).toUTCString(), 0), 60_000)
  assert.equal(parseRetryAfterMs('garbage', 0), 0)
})
