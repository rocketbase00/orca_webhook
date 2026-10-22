import { canonicalJson, sha256Hex } from './canonical-json.mjs'
import { s, validate } from './schema.mjs'

// Bridge event envelope (spec §7). This is the Bridge's own contract; Orca
// never emits this JSON itself.

export const ENVELOPE_SCHEMA_VERSION = 1

export const EVENT_TYPES = {
  'agent.status.changed': 'state_change',
  'bridge.lifecycle': 'lifecycle'
}

/**
 * Opaque stream id from device, epoch and the Orca identifiers. It names a
 * collection stream, not an agent run: Orca exposes no reliable session id.
 */
export function deriveStreamId({ deviceId, epoch, kind, worktreeId = null, paneKey = null }) {
  return `stream-${sha256Hex(canonicalJson([deviceId, epoch, kind, worktreeId, paneKey])).slice(0, 16)}`
}

export function buildEnvelope({ eventId, eventType, observedAt, source, stream, context, data }) {
  // Key order mirrors the spec sample so stored bodies read naturally.
  return {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    event_id: eventId,
    event_type: eventType,
    kind: EVENT_TYPES[eventType],
    observed_at: observedAt,
    source: {
      device_id: source.deviceId,
      epoch: source.epoch,
      orca_version: source.orcaVersion ?? null,
      plugin_version: source.pluginVersion
    },
    stream: { id: stream.id, sequence: stream.sequence },
    context: {
      worktree_id: context.worktreeId ?? null,
      pane_key: context.paneKey ?? null,
      provider: context.provider ?? null,
      linear_issue: context.linearIssue ?? null
    },
    data
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const jsonValue = (value) => value

const mainAgentSchema = s.object({
  state: s.string({ min: 1, max: 256 }),
  outcome: s.optional(s.string({ min: 1, max: 256 })),
  stateStartedAt: s.number()
})

const stateChangeDataSchema = s.object({
  previous_state: s.nullable(s.string({ min: 1, max: 256 })),
  state: s.string({ min: 1, max: 256 }),
  normalized_state: s.oneOf(['working', 'waiting', 'done', 'unknown']),
  received_at_raw: s.number({ positive: true }),
  main_agent: s.nullable(mainAgentSchema),
  evidence: s.oneOf(['orca_plugin_event'])
})

const lifecycleDataSchema = s.object({
  reason: s.string({ min: 1, max: 64, pattern: /^[a-z][a-z0-9_]*$/ }),
  detail: s.optional(jsonValue, {})
})

const envelopeBaseSchema = s.object({
  schema_version: s.literal(ENVELOPE_SCHEMA_VERSION),
  event_id: s.string({ pattern: UUID_RE, patternMessage: 'must be a lowercase UUID' }),
  event_type: s.oneOf(Object.keys(EVENT_TYPES)),
  kind: s.oneOf(Object.values(EVENT_TYPES)),
  observed_at: s.string({ max: 64, pattern: RFC3339_RE, patternMessage: 'must be an RFC 3339 timestamp' }),
  source: s.object({
    device_id: s.string({ pattern: ID_RE }),
    epoch: s.string({ pattern: UUID_RE }),
    orca_version: s.nullable(s.string({ min: 1, max: 64 })),
    plugin_version: s.string({ min: 1, max: 64 })
  }),
  stream: s.object({
    id: s.string({ min: 1, max: 128, pattern: ID_RE }),
    sequence: s.number({ int: true, min: 1 })
  }),
  context: s.object({
    worktree_id: s.nullable(s.string({ min: 1, max: 2048 })),
    pane_key: s.nullable(s.string({ min: 1, max: 2048 })),
    provider: s.nullable(s.string({ min: 1, max: 64 })),
    linear_issue: s.nullable(s.object({ id: s.string({ min: 1, max: 128 }), identifier: s.string({ min: 1, max: 64 }) }))
  }),
  data: jsonValue
})

/** Receiver-side contract check: strict top level, typed `data` per event type. */
export function parseEnvelope(raw) {
  const envelope = validate(envelopeBaseSchema, raw)
  if (EVENT_TYPES[envelope.event_type] !== envelope.kind) {
    throw new Error(`kind: must be "${EVENT_TYPES[envelope.event_type]}" for ${envelope.event_type}`)
  }
  if (envelope.event_type === 'agent.status.changed') {
    envelope.data = validate(stateChangeDataSchema, envelope.data)
    if (envelope.context.pane_key === null) throw new Error('context.pane_key: is required for state events')
  } else {
    envelope.data = validate(lifecycleDataSchema, envelope.data)
  }
  return envelope
}
