import { createHmac, timingSafeEqual } from 'node:crypto'

// Generic HMAC V2 as implemented by Hermes' webhook adapter (checked
// 2026-10-21): hex(HMAC_SHA256(utf8(secret), ascii(timestamp) + "." + raw_body)).
// The secret's string form is the key; both sides must use the same string.

export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300

export function signV2(secret, timestampSeconds, bodyBytes) {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(`${timestampSeconds}.`, 'ascii'))
    .update(bodyBytes)
    .digest('hex')
}

/** Constant-time compare of two hex signatures; false on any shape mismatch. */
export function signaturesEqual(provided, expected) {
  if (typeof provided !== 'string' || !/^[0-9a-f]{64}$/.test(provided)) return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function verifyV2({ secret, timestampHeader, signatureHeader, bodyBytes, nowSeconds, toleranceSeconds = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS }) {
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' }
  if (!timestampHeader || !/^\d{1,12}$/.test(timestampHeader)) return { ok: false, reason: 'missing_timestamp' }
  if (Math.abs(nowSeconds - Number(timestampHeader)) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_out_of_window' }
  }
  if (!signaturesEqual(signatureHeader, signV2(secret, timestampHeader, bodyBytes))) {
    return { ok: false, reason: 'bad_signature' }
  }
  return { ok: true }
}
