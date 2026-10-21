import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signV2, verifyV2 } from '../plugin/lib/signing.mjs'
import { TEST_SECRET } from './helpers.mjs'

const body = Buffer.from('{"event_id":"x","n":1}', 'utf8')

test('signV2 matches the Hermes generic V2 algorithm (vector computed with Python hmac)', () => {
  assert.equal(signV2(TEST_SECRET, 1792544400, body), '6f9230d0be90c8c72652e6f3a24f0013f50a8d85c89876fa2408c1b3bd450c34')
})

test('verifyV2 rejects tampering, wrong secret, stale timestamps and malformed signatures (A18)', () => {
  const ts = '1792544400'
  const signature = signV2(TEST_SECRET, ts, body)
  const ok = { secret: TEST_SECRET, timestampHeader: ts, signatureHeader: signature, bodyBytes: body, nowSeconds: 1792544400 }
  assert.deepEqual(verifyV2(ok), { ok: true })
  assert.equal(verifyV2({ ...ok, bodyBytes: Buffer.from('{"event_id":"x","n":2}') }).reason, 'bad_signature')
  assert.equal(verifyV2({ ...ok, secret: 'f'.repeat(64) }).reason, 'bad_signature')
  assert.equal(verifyV2({ ...ok, nowSeconds: 1792544400 + 301 }).reason, 'timestamp_out_of_window')
  assert.equal(verifyV2({ ...ok, signatureHeader: signature.toUpperCase() }).reason, 'bad_signature')
  assert.equal(verifyV2({ ...ok, signatureHeader: undefined }).reason, 'missing_signature')
  assert.equal(verifyV2({ ...ok, timestampHeader: 'abc' }).reason, 'missing_timestamp')
})
