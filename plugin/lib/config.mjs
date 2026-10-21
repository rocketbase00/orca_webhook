import { readFileSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { sha256Hex } from './canonical-json.mjs'
import { isValidDirectoryRef } from './paths.mjs'
import { SchemaError, s, validate } from './schema.mjs'

// Bridge-specific config.json (spec §17.3). Not an Orca settings key set:
// `bridgeConfigVersion` is unrelated to Orca's `manifestVersion`.

export const BRIDGE_CONFIG_VERSION = 1

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const id = (what) => s.string({ min: 1, max: 128, pattern: ID_RE, patternMessage: `must be a ${what} (letters, digits, . _ -)` })
const SECRET_REF_RE = /^(keychain:[^/\s]+\/[^\s]+|file:\/[^\s]+)$/
const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/
const PROVIDER_RE = /^[a-z][a-z0-9_]{0,63}$/

const configSchema = s.object({
  bridgeConfigVersion: s.literal(BRIDGE_CONFIG_VERSION),
  enabled: s.boolean(),
  mode: s.oneOf(['dry_run', 'live']),
  source: s.object({
    deviceId: id('device id')
  }),
  collector: s.object({
    events: s.optional(s.array(s.oneOf(['agent.status.changed']), { max: 1, unique: true }), ['agent.status.changed']),
    scope: s.object({
      worktreeIds: s.optional(s.array(s.string({ min: 1, max: 2048 }), { max: 1000, unique: true }), []),
      paneKeys: s.optional(s.array(s.string({ min: 1, max: 2048 }), { max: 1000, unique: true }), []),
      includeUnscoped: s.optional(s.boolean(), false)
    }),
    includeMainAgent: s.optional(s.boolean(), true),
    includeTranscript: s.optional(
      s.literal(false, 'must stay false: transcript forwarding needs a separate design and consent (spec §17.3)'),
      false
    ),
    unknownStatePolicy: s.optional(s.oneOf(['forward_as_unknown']), 'forward_as_unknown')
  }),
  sender: s.object({
    runAs: s.optional(s.oneOf(['user_launch_agent']), 'user_launch_agent'),
    resumeCheckIntervalSeconds: s.optional(s.number({ min: 5, max: 60, int: true }), 60),
    endpointId: id('endpoint id'),
    endpointUrl: s.string({ min: 1, max: 2048 }),
    allowedHosts: s.array(s.string({ min: 1, max: 253 }), { min: 1, max: 16, unique: true }),
    followRedirects: s.optional(s.literal(false, 'must be false: redirects are never followed (spec §12.2)'), false),
    connectTimeoutSeconds: s.optional(s.number({ min: 0.1, max: 60 }), 3),
    requestTimeoutSeconds: s.optional(s.number({ min: 1, max: 120 }), 10),
    maxConcurrentRequests: s.optional(s.number({ min: 1, max: 16, int: true }), 2),
    maxRequestsPerSecond: s.optional(s.number({ min: 0.1, max: 100 }), 10),
    /** Which success contract to accept: this repo's Bridge Ingress, or Hermes' built-in webhook route. */
    responseContract: s.optional(s.oneOf(['bridge_v1', 'hermes_webhook']), 'bridge_v1'),
    heartbeat: s.optional(
      s.object({
        enabled: s.optional(s.boolean(), true),
        intervalSeconds: s.optional(s.number({ min: 15, max: 3600, int: true }), 60)
      }),
      { enabled: true, intervalSeconds: 60 }
    ),
    signing: s.object({
      scheme: s.oneOf(['generic_hmac_v2']),
      keyId: id('key id'),
      secretRef: s.string({
        min: 1,
        max: 1024,
        pattern: SECRET_REF_RE,
        patternMessage: 'must be "keychain:<service>/<account>" or "file:/absolute/path" (never the secret itself)'
      })
    }),
    retry: s.optional(
      s.object({
        initialDelaySeconds: s.optional(s.number({ min: 1, max: 3600 }), 5),
        maxDelaySeconds: s.optional(s.number({ min: 1, max: 86400 }), 900),
        jitter: s.optional(s.boolean(), true),
        maxEventAgeDays: s.optional(s.number({ min: 1, max: 365 }), 30)
      }),
      { initialDelaySeconds: 5, maxDelaySeconds: 900, jitter: true, maxEventAgeDays: 30 }
    )
  }),
  queue: s.optional(
    s.object({
      engine: s.optional(s.oneOf(['sqlite']), 'sqlite'),
      directoryRef: s.optional(
        s.string({ min: 1, max: 256, pattern: /^user_application_support\//, patternMessage: 'must be "user_application_support/<name>"' }),
        'user_application_support/OrcaWebhookBridge'
      ),
      maxUndeliveredEvents: s.optional(s.number({ min: 10, max: 10_000_000, int: true }), 100_000),
      maxDiskBytes: s.optional(s.number({ min: 1024 * 1024, int: true }), 268_435_456),
      minFreeDiskBytes: s.optional(s.number({ min: 0, int: true }), 268_435_456),
      maxPayloadBytes: s.optional(s.number({ min: 1024, max: 262_144, int: true }), 16_384),
      deliveredRetentionDays: s.optional(s.number({ min: 1, max: 365 }), 7),
      attemptLogRetentionDays: s.optional(s.number({ min: 1, max: 365 }), 30),
      overflowPolicy: s.optional(s.oneOf(['stop_collection_and_alert']), 'stop_collection_and_alert')
    }),
    {}
  ),
  context: s.optional(
    s.object({
      providerByPaneKey: s.optional(
        s.record(s.string({ min: 1, max: 64, pattern: PROVIDER_RE, patternMessage: 'must be a provider slug such as "claude_code" or "codex"' }), { max: 1000 }),
        {}
      ),
      linearIssueByStreamId: s.optional(
        s.record(
          s.object({
            id: s.string({ min: 1, max: 128 }),
            identifier: s.string({ min: 3, max: 64, pattern: LINEAR_IDENTIFIER_RE, patternMessage: 'must look like "DEV-123"' })
          }),
          { max: 1000 }
        ),
        {}
      )
    }),
    {}
  ),
  actions: s.optional(
    s.object({
      enabled: s.optional(s.literal(false, 'must be false: approved actions are not implemented in this version (spec Phase 4)'), false),
      requireExplicitApproval: s.optional(s.literal(true), true),
      approvalTtlSeconds: s.optional(s.number({ min: 60, max: 3600, int: true }), 900),
      offlinePolicy: s.optional(s.oneOf(['defer_and_revalidate']), 'defer_and_revalidate'),
      allowedActionTypes: s.optional(s.array(s.string(), { max: 0 }), [])
    }),
    {}
  )
})

const SECRET_LIKE_KEY_RE = /(secret|token|password|passwd|api[-_]?key|private[-_]?key|credential)/i

/** Rejects secrets written into config.json (spec §10.3, §17.3). `secretRef` holds only a reference. */
function rejectInlineSecrets(value, path = '') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectInlineSecrets(entry, path ? `${path}.${index}` : String(index)))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const keyPath = path ? `${path}.${key}` : key
      if (key !== 'secretRef' && SECRET_LIKE_KEY_RE.test(key)) {
        throw new SchemaError(keyPath, 'secrets must not be stored in config.json; use sender.signing.secretRef')
      }
      rejectInlineSecrets(entry, keyPath)
    }
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

/** https only (http just for loopback tests), no credentials, host pinned by allowedHosts (spec §18). */
export function validateEndpointUrl(raw, allowedHosts, path = 'sender.endpointUrl') {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new SchemaError(path, 'must be an absolute URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new SchemaError(path, 'must use https (plain http is allowed only for loopback testing)')
  }
  if (url.username || url.password) throw new SchemaError(path, 'must not embed credentials')
  if (url.hash) throw new SchemaError(path, 'must not contain a fragment')
  for (const key of url.searchParams.keys()) {
    if (SECRET_LIKE_KEY_RE.test(key) || /^(sig|signature|key)$/i.test(key)) {
      throw new SchemaError(path, 'must not carry secrets in the query string')
    }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const allowed = allowedHosts.map((entry) => entry.replace(/^\[|\]$/g, '').toLowerCase())
  if (!allowed.includes(host)) throw new SchemaError(path, `host "${host}" is not in sender.allowedHosts`)
  if (isIP(host) === 0 && !/^[a-z0-9.-]+$/.test(host)) throw new SchemaError(path, 'has an invalid host')
  return url
}

export function parseConfig(raw) {
  rejectInlineSecrets(raw)
  const config = validate(configSchema, raw)
  validateEndpointUrl(config.sender.endpointUrl, config.sender.allowedHosts)
  if (!isValidDirectoryRef(config.queue.directoryRef)) {
    throw new SchemaError('queue.directoryRef', 'must be "user_application_support/<name>"')
  }
  if (config.sender.retry.maxDelaySeconds < config.sender.retry.initialDelaySeconds) {
    throw new SchemaError('sender.retry.maxDelaySeconds', 'must be >= initialDelaySeconds')
  }
  return config
}

/** Parses config bytes as a whole; nothing is applied unless every check passes (atomic reload). */
export function parseConfigText(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new SchemaError('(file)', `invalid JSON: ${error.message}`)
  }
  return { config: parseConfig(raw), revision: sha256Hex(text).slice(0, 16) }
}

/**
 * Re-reads config.json only when its stat signature changes. A broken edit
 * keeps reporting the error instead of silently reusing a stale config.
 */
export function createConfigCache(path) {
  let signature = null
  let current = null
  return {
    path,
    get() {
      let stat
      try {
        stat = statSync(path)
      } catch (error) {
        signature = null
        current = { ok: false, missing: error.code === 'ENOENT', error: error.code === 'ENOENT' ? `config not found: ${path}` : error.message }
        return current
      }
      const nextSignature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`
      if (nextSignature === signature && current) return current
      signature = nextSignature
      try {
        const loaded = parseConfigText(readFileSync(path, 'utf8'))
        current = { ok: true, ...loaded, insecureMode: (stat.mode & 0o077) !== 0 }
      } catch (error) {
        current = { ok: false, missing: false, error: error.message }
      }
      return current
    }
  }
}

/** Starting config written by `owb init`: everything off, dry-run, empty scope (= collect nothing). */
export function defaultConfig({ deviceId, endpointId = 'hermes-private-01', endpointUrl, keyId = 'bridge-key-01' }) {
  const url = endpointUrl ?? 'https://hermes-host.example-tailnet.ts.net/bridge/v1/events'
  return {
    bridgeConfigVersion: BRIDGE_CONFIG_VERSION,
    enabled: false,
    mode: 'dry_run',
    source: { deviceId },
    collector: {
      events: ['agent.status.changed'],
      scope: { worktreeIds: [], paneKeys: [], includeUnscoped: false },
      includeMainAgent: true,
      includeTranscript: false,
      unknownStatePolicy: 'forward_as_unknown'
    },
    sender: {
      runAs: 'user_launch_agent',
      resumeCheckIntervalSeconds: 60,
      endpointId,
      endpointUrl: url,
      allowedHosts: [new URL(url).hostname],
      followRedirects: false,
      connectTimeoutSeconds: 3,
      requestTimeoutSeconds: 10,
      maxConcurrentRequests: 2,
      maxRequestsPerSecond: 10,
      responseContract: 'bridge_v1',
      heartbeat: { enabled: true, intervalSeconds: 60 },
      signing: {
        scheme: 'generic_hmac_v2',
        keyId,
        secretRef: `keychain:orca-webhook-bridge/${endpointId}`
      },
      retry: { initialDelaySeconds: 5, maxDelaySeconds: 900, jitter: true, maxEventAgeDays: 30 }
    },
    queue: {
      engine: 'sqlite',
      directoryRef: 'user_application_support/OrcaWebhookBridge',
      maxUndeliveredEvents: 100000,
      maxDiskBytes: 268435456,
      minFreeDiskBytes: 268435456,
      maxPayloadBytes: 16384,
      deliveredRetentionDays: 7,
      attemptLogRetentionDays: 30,
      overflowPolicy: 'stop_collection_and_alert'
    },
    context: { providerByPaneKey: {}, linearIssueByStreamId: {} },
    actions: {
      enabled: false,
      requireExplicitApproval: true,
      approvalTtlSeconds: 900,
      offlinePolicy: 'defer_and_revalidate',
      allowedActionTypes: []
    }
  }
}
