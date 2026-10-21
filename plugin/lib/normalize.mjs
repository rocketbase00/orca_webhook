import { s, validate } from './schema.mjs'

// Orca `agent.status.changed` payload (plugin-events.ts, checked 2026-10-21).
// Non-strict: a newer host may add fields; we keep only the ones listed here
// so nothing unexpected is ever forwarded (spec §6.2).
const agentStatusPayloadSchema = s.object(
  {
    worktreeId: s.nullable(s.string({ min: 1, max: 2048 })),
    paneKey: s.string({ min: 1, max: 2048 }),
    state: s.string({ min: 1, max: 256 }),
    receivedAt: s.number({ positive: true }),
    mainAgent: s.optional(
      s.object(
        {
          state: s.string({ min: 1, max: 256 }),
          outcome: s.optional(s.string({ min: 1, max: 256 })),
          stateStartedAt: s.number()
        },
        { strict: false }
      )
    )
  },
  { strict: false }
)

export function parseAgentStatusPayload(payload) {
  return validate(agentStatusPayloadSchema, payload)
}

// Display normalization only (spec §6.3). `done` is "observed as finished",
// never success; anything else is `unknown` and keeps its raw value.
const KNOWN_STATES = new Set(['working', 'waiting', 'done'])

export function normalizeState(raw) {
  return KNOWN_STATES.has(raw) ? raw : 'unknown'
}

/** Scope rule (spec §17.3): empty scope collects nothing; both lists set → both must match. */
export function isInScope(scope, worktreeId, paneKey) {
  const { worktreeIds, paneKeys, includeUnscoped } = scope
  if (worktreeIds.length === 0 && paneKeys.length === 0) return false
  const worktreeOk = worktreeId === null ? includeUnscoped : worktreeIds.length === 0 || worktreeIds.includes(worktreeId)
  const paneOk = paneKeys.length === 0 || paneKeys.includes(paneKey)
  return worktreeOk && paneOk
}
