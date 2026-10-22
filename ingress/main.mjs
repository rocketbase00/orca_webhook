#!/usr/bin/env node
// Orca Webhook Bridge — Ingress (runs on the Hermes PC).
//   node ingress/main.mjs serve  [--config PATH]
//   node ingress/main.mjs status [--config PATH] [--json]
//   node ingress/main.mjs check-config [--config PATH]
// Default config: ~/.config/orca-webhook-bridge/ingress.config.json

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createLogger } from '../lib/logger.mjs'
import { resolveSecretRef } from '../lib/secret-ref.mjs'
import { loadIngressConfig } from './lib/ingress-config.mjs'
import { createIngress } from './lib/ingress.mjs'
import { openInbox } from './lib/inbox-db.mjs'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: process.env.ORCA_BRIDGE_INGRESS_CONFIG ?? join(homedir(), '.config', 'orca-webhook-bridge', 'ingress.config.json') },
    json: { type: 'boolean', default: false }
  }
})
const command = positionals[0] ?? 'serve'

function fmtAge(ms) {
  if (ms === null || ms === undefined) return '-'
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 120) return `${seconds}s ago`
  if (seconds < 7200) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

async function serve(config) {
  const log = createLogger({ dir: join(config.dataDir, 'logs'), name: 'ingress' })
  const ingress = createIngress({ config, log })
  const handler = (req, res) => void ingress.handleRequest(req, res)
  const server = config.tls
    ? https.createServer({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile), minVersion: 'TLSv1.2' }, handler)
    : http.createServer(handler)
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.listen(config.listen.port, config.listen.host, () => {
    log.info(`ingress listening on ${config.tls ? 'https' : 'http'}://${config.listen.host}:${config.listen.port}${config.basePath}/events`)
  })
  ingress.start()
  const shutdown = async (signal) => {
    log.info(`${signal} received; shutting down`)
    server.close()
    await ingress.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

function status(config) {
  const { db } = openInbox(config.dataDir)
  const staleMs = config.processing.heartbeatStaleSeconds * 1000
  const sources = db.prepare('SELECT * FROM sources ORDER BY device_id').all()
  const streams = db.prepare('SELECT * FROM stream_state ORDER BY last_observed_at DESC LIMIT 50').all()
  const inbox = db.prepare('SELECT status, COUNT(*) AS n FROM inbox GROUP BY status').all()
  const effects = db.prepare("SELECT status, COUNT(*) AS n FROM side_effects GROUP BY status").all()
  const conflicts = db.prepare('SELECT COUNT(*) AS n FROM conflicts').get().n
  const gaps = db.prepare('SELECT * FROM stream_gaps ORDER BY id DESC LIMIT 10').all()
  const report = {
    sources: sources.map((row) => {
      const heartbeat = row.heartbeat_json ? JSON.parse(row.heartbeat_json) : null
      return {
        deviceId: row.device_id,
        epoch: row.epoch,
        // Missing heartbeats mean "unknown", never "asleep" (spec §13.3).
        reachability: row.last_heartbeat_at && Date.now() - row.last_heartbeat_at <= staleMs ? 'up' : 'unknown',
        lastHeartbeatAt: row.last_heartbeat_at,
        lastEventReceivedAt: row.last_event_received_at,
        senderReported: heartbeat ? { mode: heartbeat.mode, collector: heartbeat.collector, queue: heartbeat.queue } : null
      }
    }),
    streams: streams.map((row) => ({
      deviceId: row.device_id,
      streamId: row.stream_id,
      kind: row.kind,
      state: row.current_state,
      normalizedState: row.normalized_state,
      mainAgent: row.main_agent_json ? JSON.parse(row.main_agent_json) : null,
      worktreeId: row.worktree_id,
      paneKey: row.pane_key,
      linearIssue: row.linear_issue_json ? JSON.parse(row.linear_issue_json) : null,
      sequence: row.max_applied_sequence,
      lastObservedAt: row.last_observed_at
    })),
    inbox: Object.fromEntries(inbox.map((row) => [row.status, row.n])),
    sideEffects: Object.fromEntries(effects.map((row) => [row.status, row.n])),
    conflicts,
    recentGaps: gaps.map((row) => ({ streamId: row.stream_id, from: row.from_sequence, to: row.to_sequence, detectedAt: row.detected_at }))
  }
  db.close()
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log('== Sources ==')
  for (const source of report.sources) {
    console.log(`  ${source.deviceId}  reachability: ${source.reachability}  last heartbeat: ${fmtAge(source.lastHeartbeatAt)}  last event received: ${fmtAge(source.lastEventReceivedAt)}`)
    if (source.senderReported) {
      const { collector, queue } = source.senderReported
      console.log(`    reported by Sender: Collector last collected ${collector?.last_event_at ?? '-'} / undelivered ${queue?.undelivered ?? '-'} / dead letters ${queue?.dead_letter ?? '-'}`)
    }
  }
  console.log('== Streams (state as last observed, not a guarantee of the current state) ==')
  for (const stream of report.streams) {
    const issue = stream.linearIssue ? ` [${stream.linearIssue.identifier}]` : ''
    console.log(`  ${stream.streamId}${issue}  ${stream.kind === 'state_change' ? `${stream.normalizedState} (${stream.state})` : stream.state}  #${stream.sequence}  observed ${stream.lastObservedAt}`)
  }
  console.log(`== Inbox == ${JSON.stringify(report.inbox)}  side effects: ${JSON.stringify(report.sideEffects)}  ID conflicts: ${report.conflicts}`)
  if (report.recentGaps.length > 0) {
    console.log('== Recent sequence gaps ==')
    for (const gap of report.recentGaps) console.log(`  ${gap.streamId}  #${gap.from}-#${gap.to}`)
  }
}

let config
try {
  config = loadIngressConfig(values.config)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
async function checkConfig(config) {
  console.log(`OK: ${values.config}`)
  // Fingerprints let you compare with `owb secret check` on the Mac without revealing the key.
  for (const key of config.keys) {
    try {
      const secret = await resolveSecretRef(key.secretRef, { allowEnv: true })
      console.log(`  key ${key.keyId}${key.enabled ? '' : ' (disabled)'}: fingerprint ${createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12)}`)
    } catch (error) {
      console.log(`  key ${key.keyId}: cannot read (${error.code ?? error.message})`)
    }
  }
}

if (command === 'serve') await serve(config)
else if (command === 'status') status(config)
else if (command === 'check-config') await checkConfig(config)
else {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
