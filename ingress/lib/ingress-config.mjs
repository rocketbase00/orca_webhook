import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isLoopbackHost } from '../../plugin/lib/config.mjs'
import { SchemaError, s, validate } from '../../plugin/lib/schema.mjs'

// Bridge Ingress config (Hermes side). The Ingress is this repo's receiver
// adapter (spec §11.2 recommended option), not an existing Hermes URL.

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const UUID_OR_STAR_RE = /^(\*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const SECRET_REF = s.string({
  min: 1,
  max: 1024,
  pattern: /^(file:\/\S+|env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^/\s]+\/\S+)$/,
  patternMessage: 'must be "file:/abs/path", "env:NAME" or "keychain:<service>/<account>"'
})

export const DEFAULT_SOURCE_CIDRS = ['127.0.0.1/32', '::1/128', '100.64.0.0/10', 'fd7a:115c:a1e0::/48']

const ingressConfigSchema = s.object({
  ingressConfigVersion: s.literal(1),
  listen: s.object({
    host: s.optional(s.string({ min: 1, max: 253 }), '127.0.0.1'),
    port: s.optional(s.number({ min: 1, max: 65535, int: true }), 8645),
    /** 0.0.0.0 / :: are refused unless explicitly allowed (spec §10.1). */
    allowWildcardBind: s.optional(s.boolean(), false)
  }),
  tls: s.optional(s.nullable(s.object({ certFile: s.string({ min: 1 }), keyFile: s.string({ min: 1 }) })), null),
  dataDir: s.optional(s.string({ min: 1, max: 1024 })),
  basePath: s.optional(s.string({ pattern: /^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/ }), '/bridge/v1'),
  allowedSourceCidrs: s.optional(s.array(s.string({ min: 3, max: 64 }), { min: 1, max: 64 }), DEFAULT_SOURCE_CIDRS),
  maxBodyBytes: s.optional(s.number({ min: 1024, max: 1_048_576, int: true }), 65_536),
  timestampToleranceSeconds: s.optional(s.number({ min: 30, max: 900, int: true }), 300),
  keys: s.array(
    s.object({
      keyId: s.string({ pattern: ID_RE }),
      secretRef: SECRET_REF,
      enabled: s.optional(s.boolean(), true)
    }),
    { min: 1, max: 16 }
  ),
  sources: s.array(
    s.object({
      deviceId: s.string({ pattern: ID_RE }),
      keyIds: s.array(s.string({ pattern: ID_RE }), { min: 1, max: 16 }),
      /** Registered outbox epochs; "*" explicitly accepts any (e.g. while setting up). */
      epochs: s.array(s.string({ pattern: UUID_OR_STAR_RE, patternMessage: 'must be an epoch UUID or "*"' }), { min: 1, max: 64 })
    }),
    { min: 1, max: 64 }
  ),
  processing: s.optional(
    s.object({
      heartbeatStaleSeconds: s.optional(s.number({ min: 30, max: 86400, int: true }), 180),
      forward: s.optional(
        s.object({
          enabled: s.optional(s.boolean(), false),
          url: s.optional(s.string({ min: 1, max: 2048 })),
          secretRef: s.optional(SECRET_REF),
          states: s.optional(s.array(s.oneOf(['working', 'waiting', 'done', 'unknown']), { unique: true }), ['waiting', 'done']),
          lifecycleReasons: s.optional(s.array(s.string({ pattern: /^[a-z][a-z0-9_]*$/ }), { unique: true }), ['collection_fault']),
          historicalAfterSeconds: s.optional(s.number({ min: 0, max: 86400 * 30, int: true }), 600),
          connectTimeoutSeconds: s.optional(s.number({ min: 0.1, max: 60 }), 3),
          requestTimeoutSeconds: s.optional(s.number({ min: 1, max: 120 }), 15),
          maxAttempts: s.optional(s.number({ min: 1, max: 1000, int: true }), 20)
        }),
        { enabled: false }
      )
    }),
    {}
  ),
  retention: s.optional(s.object({ processedBodyDays: s.optional(s.number({ min: 1, max: 3650 }), 90) }), {})
})

export function defaultIngressDataDir() {
  return join(homedir(), '.local', 'share', 'orca-webhook-bridge-ingress')
}

export function parseIngressConfig(raw) {
  const config = validate(ingressConfigSchema, raw)
  config.dataDir = config.dataDir ?? defaultIngressDataDir()
  if (!isAbsolute(config.dataDir)) throw new SchemaError('dataDir', 'must be an absolute path')
  const host = config.listen.host
  if ((host === '0.0.0.0' || host === '::') && !config.listen.allowWildcardBind) {
    throw new SchemaError('listen.host', 'wildcard bind is refused by default; bind the Tailscale address or 127.0.0.1 behind "tailscale serve"')
  }
  const keyIds = new Set(config.keys.map((key) => key.keyId))
  if (keyIds.size !== config.keys.length) throw new SchemaError('keys', 'keyId values must be unique')
  for (const [index, source] of config.sources.entries()) {
    for (const keyId of source.keyIds) {
      if (!keyIds.has(keyId)) throw new SchemaError(`sources.${index}.keyIds`, `unknown keyId "${keyId}"`)
    }
  }
  const forward = config.processing.forward
  if (forward.enabled) {
    if (!forward.url || !forward.secretRef) throw new SchemaError('processing.forward', 'url and secretRef are required when enabled')
    let url
    try {
      url = new URL(forward.url)
    } catch {
      throw new SchemaError('processing.forward.url', 'must be an absolute URL')
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      throw new SchemaError('processing.forward.url', 'must use https (plain http only for a Hermes on this machine)')
    }
  }
  return config
}

export function loadIngressConfig(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ingress config ${path}: ${error.message}`)
  }
  return parseIngressConfig(raw)
}
