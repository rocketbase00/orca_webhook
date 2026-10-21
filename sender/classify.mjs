// Maps one delivery attempt to the next queue state (spec §10.4, §12.2).
// Pure functions: no I/O, so every row of the spec tables is unit-testable.

export const PAUSE_RECHECK_MS = {
  auth: 15 * 60_000,
  tls: 15 * 60_000,
  secret_unavailable: 60_000
}

/** Exponential backoff with ±25% jitter: ~5s, 15s, 45s, 2m, 7m, then the cap (spec §12.1). */
export function retryDelayMs(attempt, retry, random = Math.random) {
  const base = Math.min(retry.initialDelaySeconds * 3 ** Math.max(0, attempt - 1), retry.maxDelaySeconds) * 1000
  if (!retry.jitter) return base
  return Math.round(base * (0.75 + random() * 0.5))
}

/** Retry-After as a lower bound, capped at one hour so a bogus header cannot park the queue. */
export function parseRetryAfterMs(header, nowMs) {
  if (!header) return 0
  const value = Array.isArray(header) ? header[0] : header
  if (/^\d+$/.test(value.trim())) return Math.min(Number(value) * 1000, 3_600_000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? 0 : Math.min(Math.max(0, date - nowMs), 3_600_000)
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

/** A success only counts when it matches the contract and names this event (spec §10.4). */
export function validateSuccess(response, eventId, contract) {
  const body = parseJson(response.body)
  if (!body || typeof body !== 'object') return { ok: false, reason: 'non-JSON success response' }
  if (contract === 'bridge_v1') {
    const expected = response.status === 202 ? 'accepted' : response.status === 200 ? 'duplicate' : null
    if (!expected) return { ok: false, reason: `unexpected success status ${response.status}` }
    if (body.status !== expected) return { ok: false, reason: `status "${String(body.status).slice(0, 32)}" with HTTP ${response.status}` }
    if (body.event_id !== eventId) return { ok: false, reason: 'event_id mismatch' }
    if (body.durable !== true) return { ok: false, reason: 'receiver did not confirm durable storage' }
    return { ok: true, duplicate: expected === 'duplicate' }
  }
  // Hermes built-in webhook route: accepted/202 or duplicate/200 echoing our X-Request-ID as delivery_id.
  const accepted = response.status === 202 && body.status === 'accepted'
  const duplicate = response.status === 200 && body.status === 'duplicate'
  if (!accepted && !duplicate) return { ok: false, reason: `Hermes response "${String(body.status).slice(0, 32)}" with HTTP ${response.status}` }
  if (body.delivery_id !== eventId) return { ok: false, reason: 'delivery_id mismatch' }
  return { ok: true, duplicate }
}

function summarize(response) {
  const body = parseJson(response.body)
  const parts = [`HTTP ${response.status}`]
  if (body && typeof body === 'object') {
    for (const key of ['status', 'error', 'reason']) {
      if (typeof body[key] === 'string') parts.push(`${key}=${body[key].slice(0, 80)}`)
    }
  }
  return parts.join(' ')
}

/**
 * @returns {{outcome: string, status: string, errorClass: string|null, reachable: boolean|null,
 *            pause: {kind: string, reason: string}|null, deadReason: string|null, summary: string,
 *            minDelayMs: number, throttle: boolean}}
 */
export function classifyAttempt(result, { eventId, contract, nowMs }) {
  const base = { errorClass: null, reachable: null, pause: null, deadReason: null, minDelayMs: 0, throttle: false }
  if (result.kind === 'error') {
    if (result.phase === 'tls') {
      return { ...base, outcome: 'tls_error', status: 'blocked_config', errorClass: 'tls', pause: { kind: 'tls', reason: `TLS error ${result.code}` }, summary: `TLS ${result.code}` }
    }
    if (result.phase === 'connect') {
      // The connection was never established, so the receiver certainly did not get it.
      return { ...base, outcome: 'network_error', status: 'retry_wait', errorClass: 'network', reachable: false, summary: result.code }
    }
    // The request may have reached the receiver: resend with the same id; the receiver dedupes (spec §9.1).
    // Its own class, so a slow receiver keeps its backoff instead of being flushed on reconnect.
    return { ...base, outcome: 'no_response', status: 'retry_wait', errorClass: 'no_response', reachable: null, summary: result.code }
  }

  const status = result.status
  const summary = summarize(result)
  const reachable = true
  if (status >= 200 && status < 300) {
    const verdict = validateSuccess(result, eventId, contract)
    if (verdict.ok) return { ...base, outcome: verdict.duplicate ? 'duplicate' : 'delivered', status: 'delivered', reachable, summary }
    // Not delivered: thin out retries and surface the contract mismatch.
    return { ...base, outcome: 'invalid_response', status: 'retry_wait', errorClass: 'contract', reachable, summary: `${summary} (${verdict.reason})`, minDelayMs: 5 * 60_000, throttle: true }
  }
  if (status >= 300 && status < 400) {
    return { ...base, outcome: 'redirect', status: 'blocked_config', errorClass: 'config', reachable, pause: { kind: 'redirect', reason: `HTTP ${status} redirect is not followed` }, summary }
  }
  if (status === 401 || status === 403) {
    return { ...base, outcome: 'auth_rejected', status: 'blocked_config', errorClass: 'config', reachable, pause: { kind: 'auth', reason: summary }, summary }
  }
  if (status === 404) {
    return { ...base, outcome: 'route_not_found', status: 'blocked_config', errorClass: 'config', reachable, pause: { kind: 'route', reason: summary }, summary }
  }
  if (status === 409) {
    return { ...base, outcome: 'conflict', status: 'dead_letter', reachable, deadReason: 'conflict_409', summary }
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { ...base, outcome: 'retryable_http', status: 'retry_wait', errorClass: 'server', reachable, minDelayMs: parseRetryAfterMs(result.headers?.['retry-after'], nowMs), summary }
  }
  if (status >= 400) {
    return { ...base, outcome: 'rejected', status: 'dead_letter', reachable, deadReason: `rejected_${status}`, summary }
  }
  return { ...base, outcome: 'invalid_response', status: 'retry_wait', errorClass: 'contract', reachable, summary, minDelayMs: 5 * 60_000, throttle: true }
}
