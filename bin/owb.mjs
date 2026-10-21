#!/usr/bin/env node
// owb — Orca Webhook Bridge admin CLI (spec §17.4 management features).
// Run `owb help` for the command list.

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { LAUNCH_AGENT_LABEL, launchAgentPath, renderLaunchAgentPlist } from '../lib/launchagent.mjs'
import { resolveSecretRef, storeKeychainSecret } from '../lib/secret-ref.mjs'
import { recordLifecycle } from '../plugin/lib/collector-core.mjs'
import { createConfigCache, defaultConfig, parseConfig } from '../plugin/lib/config.mjs'
import { getControl, isCollectorEnabled, isSenderEnabled, openOutbox, queueCounts, setControl, transaction } from '../plugin/lib/outbox-db.mjs'
import { bridgeDir, configPath, ensurePrivateDir, logsDir, resolveDirectoryRef } from '../plugin/lib/paths.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = homedir()

const HELP = `owb — Orca Webhook Bridge admin CLI

Setup
  owb init --device-id <id> [--endpoint-url <url>] [--endpoint-id <id>] [--key-id <id>]
  owb secret generate [--out <file>] [--print]   Generate the signing key and store it at secretRef (Keychain, file)
  owb secret check                               Check that the signing key is readable (prints a fingerprint only)
  owb config check                               Validate config.json
  owb launchagent install|uninstall|print        Manage the Sender LaunchAgent

Scope and links (config.json is validated, then replaced atomically)
  owb targets                                    Worktrees / panes seen so far (kept locally, never sent)
  owb scope add|remove --worktree <id> | --pane <key>
  owb scope unscoped on|off                      Collect events whose worktreeId is null
  owb link <streamId> <linearIssueId> <DEV-123>  Explicitly link a stream to a Linear issue
  owb unlink <streamId>
  owb provider <paneKey> <claude_code|codex|...> | owb provider <paneKey> --clear
  owb enable | owb disable                       config.enabled (whole bridge on/off)
  owb mode dry_run|live

Operations
  owb status [--json]                            Collection, sending, queue and endpoint state
  owb streams                                    Streams (to look up stream IDs)
  owb events [--status <s>] [--limit <n>]        Queued events
  owb show <eventId>                             Stored body and delivery attempts
  owb attempts [--limit <n>]                     Delivery attempt log
  owb stop | owb start                           Stop the whole bridge (collection + new sends, queue kept) / resume
  owb collector disable|enable                   Stop/resume the Collector only (sending continues)
  owb sender pause|resume                        Pause/resume the Sender only (collection continues)
  owb test-event                                 Queue a lifecycle test event
  owb requeue <eventId...> | --dead-letters | --dry-run-events
  owb discard <eventId...>                       Delete dead-letter / dry-run events (your decision)
  owb endpoint confirm                           Approve an endpoint URL change and move queued events to it
  owb reassign --from <endpointId>               Move queued events from another endpoint ID to the current one
`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    'device-id': { type: 'string' },
    'endpoint-url': { type: 'string' },
    'endpoint-id': { type: 'string' },
    'key-id': { type: 'string' },
    worktree: { type: 'string' },
    pane: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
    out: { type: 'string' },
    from: { type: 'string' },
    print: { type: 'boolean' },
    json: { type: 'boolean' },
    clear: { type: 'boolean' },
    'dead-letters': { type: 'boolean' },
    'dry-run-events': { type: 'boolean' }
  }
})

function die(message, code = 1) {
  console.error(message)
  process.exit(code)
}

function fmtTime(ms) {
  if (!ms) return '-'
  return new Date(Number(ms)).toLocaleString()
}

function fmtAge(ms) {
  if (!ms) return '-'
  const seconds = Math.round((Date.now() - Number(ms)) / 1000)
  if (seconds < 0) return `in ${-seconds}s`
  if (seconds < 120) return `${seconds}s ago`
  if (seconds < 7200) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

function loadConfig() {
  const loaded = createConfigCache(configPath(home)).get()
  if (!loaded.ok) {
    die(loaded.missing ? `config.json not found. Run "owb init --device-id <id>" first (${configPath(home)})` : `config.json is invalid: ${loaded.error}`)
  }
  return loaded
}

function withOutbox(fn) {
  const loaded = loadConfig()
  const outbox = openOutbox(resolveDirectoryRef(loaded.config.queue.directoryRef, home))
  try {
    return fn(outbox, loaded)
  } finally {
    outbox.db.close()
  }
}

/** Validate the whole edited config before writing it with an atomic rename (spec §17.3). */
function updateConfig(mutate) {
  const path = configPath(home)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  mutate(raw)
  try {
    parseConfig(raw)
  } catch (error) {
    die(`Not saved: the edited config would be invalid: ${error.message}`)
  }
  writeFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`)
}

function writeFileAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function fingerprint(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12)
}

function cmdInit() {
  const deviceId = values['device-id']
  if (!deviceId) die('--device-id is required (e.g. macbook-air-01). Use a stable ID that does not change with the host name or IP.')
  const path = configPath(home)
  if (existsSync(path)) die(`Already exists: ${path} (not overwritten)`)
  const config = defaultConfig({
    deviceId,
    endpointId: values['endpoint-id'],
    endpointUrl: values['endpoint-url'],
    keyId: values['key-id']
  })
  try {
    parseConfig(config)
  } catch (error) {
    die(`Invalid value: ${error.message}`)
  }
  ensurePrivateDir(bridgeDir(home))
  ensurePrivateDir(logsDir(home))
  writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
  const outbox = openOutbox(resolveDirectoryRef(config.queue.directoryRef, home))
  const epoch = outbox.epoch
  outbox.db.close()
  console.log(`Created ${path}
  deviceId: ${deviceId}
  epoch:    ${epoch}   <- register this in the Ingress sources[].epochs
  state:    enabled=false, mode=dry_run, nothing in scope

Next steps:
  1. Point sender.endpointUrl / allowedHosts in config.json at your receiver
  2. owb secret generate --out ./bridge-key.txt   (delete it after handing it to the receiver)
  3. Install plugin/ as a plugin in Orca and enable it
  4. owb launchagent install
  5. owb enable -> run an agent in Orca -> owb targets -> owb scope add --pane <key>`)
}

async function cmdSecret(sub) {
  const { config } = loadConfig()
  const ref = config.sender.signing.secretRef
  if (sub === 'check') {
    try {
      const secret = await resolveSecretRef(ref)
      console.log(`OK: read ${ref} (${secret.length} characters, fingerprint ${fingerprint(secret)})`)
    } catch (error) {
      die(`Cannot read ${ref} (${error.code ?? error.message})`)
    }
    return
  }
  if (sub !== 'generate') die('Usage: owb secret generate [--out <file>] [--print] | owb secret check')
  if (values.out && existsSync(values.out)) die(`Already exists: ${values.out} (not overwritten)`)
  // Overwriting a live key would silently break delivery. Rotation uses a new keyId + secretRef (spec §10.3).
  const existing = await resolveSecretRef(ref).then(
    () => true,
    (error) => error.code !== 'not_found'
  )
  if (existing) {
    die(`${ref} already holds a key (not overwritten).
To rotate: set a new sender.signing.keyId / secretRef in config.json and run owb secret generate,
add the new key to the Ingress keys so old and new are both accepted, confirm delivery, then set the old key to enabled: false.`)
  }
  const secret = randomBytes(32).toString('hex')
  if (ref.startsWith('keychain:')) {
    await storeKeychainSecret(ref, secret)
  } else {
    const file = ref.slice('file:'.length)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' })
  }
  if (values.out) writeFileSync(values.out, `${secret}\n`, { mode: 0o600, flag: 'wx' })
  console.log(`Stored the signing key at ${ref} (fingerprint ${fingerprint(secret)})`)
  if (values.out) console.log(`Wrote a copy for the receiver to ${values.out} (0600). Delete it after transferring.`)
  if (values.print) console.log(secret)
  if (!values.out && !values.print) console.log('The receiver needs the same key; export it with --out <file>.')
}

function cmdConfigCheck() {
  const loaded = loadConfig()
  console.log(`OK: ${configPath(home)} (rev ${loaded.revision})`)
  if (loaded.insecureMode) console.log('Warning: config.json is readable by others (chmod 600 recommended)')
}

function cmdStatus() {
  withOutbox((outbox, loaded) => {
    const { db } = outbox
    const { config } = loaded
    const counts = queueCounts(db)
    const endpoint = db.prepare('SELECT * FROM endpoints WHERE endpoint_id = ?').get(config.sender.endpointId)
    const senderHeartbeat = Number(getControl(db, 'sender_heartbeat_at', 0))
    const senderAlive = senderHeartbeat && Date.now() - senderHeartbeat < 10_000
    const oldest = db.prepare("SELECT MIN(observed_at) AS t FROM outbox_events WHERE status IN ('pending', 'retry_wait', 'inflight', 'blocked_config')").get().t
    const nextRetry = db.prepare("SELECT MIN(next_attempt_at) AS t FROM outbox_events WHERE status = 'retry_wait'").get().t
    const orphaned = db
      .prepare("SELECT endpoint_id, COUNT(*) AS n FROM outbox_events WHERE endpoint_id <> ? AND status IN ('pending', 'retry_wait', 'blocked_config') GROUP BY endpoint_id")
      .all(config.sender.endpointId)
    const faults = db.prepare('SELECT * FROM collection_faults WHERE resolved_at IS NULL OR last_at > ? ORDER BY last_at DESC LIMIT 10').all(Date.now() - 7 * 86_400_000)
    const collectorOn = isCollectorEnabled(db)
    const senderOn = isSenderEnabled(db)
    const report = {
      configPath: configPath(home),
      revision: loaded.revision,
      enabled: config.enabled,
      mode: config.mode,
      deviceId: config.source.deviceId,
      epoch: outbox.epoch,
      collector: { enabled: collectorOn, lastEventAt: Number(getControl(db, 'collector_last_event_at', 0)) || null, lastSeenAt: Number(getControl(db, 'collector_last_seen_at', 0)) || null },
      sender: { enabled: senderOn, alive: Boolean(senderAlive), heartbeatAt: senderHeartbeat || null, lastDeliveredAt: Number(getControl(db, 'last_delivered_at', 0)) || null },
      endpoint: endpoint ?? null,
      counts,
      oldestUndeliveredObservedAt: oldest,
      nextRetryAt: nextRetry,
      orphaned,
      faults
    }
    if (values.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    const bridgeState = !config.enabled ? 'disabled (config.enabled=false)' : !collectorOn && !senderOn ? 'stopped (whole bridge, queue kept)' : 'enabled'
    console.log(`Webhook Bridge  ${report.deviceId}  mode=${config.mode}  ${bridgeState}`)
    console.log(`  Config:    ${report.configPath} (rev ${loaded.revision})  epoch: ${outbox.epoch}`)
    console.log(`  Collector: ${collectorOn ? 'on' : 'off'}  last collected: ${fmtAge(report.collector.lastEventAt)}  last seen (incl. out of scope): ${fmtAge(report.collector.lastSeenAt)}`)
    console.log(`  Sender:    ${senderOn ? 'on' : 'off'}  process: ${senderAlive ? 'running' : `not responding (last ${fmtAge(senderHeartbeat)})`}  last delivery: ${fmtAge(report.sender.lastDeliveredAt)}`)
    if (endpoint) {
      const pause = endpoint.paused_kind ? `paused (${endpoint.paused_kind}: ${endpoint.paused_reason})${endpoint.recheck_at ? `, re-check ${fmtAge(endpoint.recheck_at)}` : ''}` : 'ready'
      console.log(`  Endpoint:  ${endpoint.endpoint_id}  ${endpoint.url}  ${pause}`)
      if (endpoint.pending_url) console.log(`    New URL ${endpoint.pending_url} is not approved yet -> owb endpoint confirm`)
      if (endpoint.last_error && (endpoint.last_failure_at ?? 0) > (endpoint.last_success_at ?? 0)) {
        console.log(`    Last error: ${endpoint.last_error} (${fmtAge(endpoint.last_failure_at)})`)
      }
    } else {
      console.log(`  Endpoint:  ${config.sender.endpointId}  ${config.sender.endpointUrl}  (Sender has not connected yet)`)
    }
    const waiting = counts.pending + counts.retry_wait + counts.inflight + counts.blocked_config
    console.log(`  Queue:     ${waiting} undelivered (pending ${counts.pending} / retry ${counts.retry_wait} / inflight ${counts.inflight} / blocked ${counts.blocked_config})  dead letters ${counts.dead_letter}  dry-run ${counts.dry_run}  delivered (retained) ${counts.delivered}`)
    console.log(`  Oldest undelivered observed: ${fmtTime(oldest)}  next retry: ${nextRetry ? fmtAge(nextRetry) : '-'}`)
    for (const row of orphaned) console.log(`  Note: ${row.n} undelivered event(s) belong to endpoint ${row.endpoint_id} and will not be sent -> owb reassign --from ${row.endpoint_id}`)
    if (!collectorOn && senderOn) console.log('  Note: only the Collector is stopped; already queued events are still being sent.')
    if (collectorOn && !senderOn) console.log('  Note: only the Sender is paused; collection continues and events accumulate in the queue.')
    if (!senderAlive && config.enabled) console.log('  Note: the Sender process is not running -> owb launchagent install')
    if (loaded.insecureMode) console.log('  Note: config.json is readable by others (chmod 600 recommended)')
    if (faults.length > 0) {
      console.log('  Collection faults (observation continuity may have been lost):')
      for (const fault of faults) {
        console.log(`    ${fault.kind} x${fault.count}  ${fmtTime(fault.first_at)} - ${fmtTime(fault.last_at)}  ${fault.resolved_at ? 'resolved' : 'ongoing'}  ${fault.detail ?? ''}`)
      }
    }
  })
}

function cmdTargets() {
  withOutbox(({ db }) => {
    const rows = db.prepare('SELECT * FROM observed_targets ORDER BY last_seen_at DESC').all()
    if (rows.length === 0) {
      console.log('Nothing observed yet. Run "owb enable", then run an agent in Orca (out-of-scope events are never sent).')
      return
    }
    for (const row of rows) {
      console.log(`${row.in_scope ? '[in scope]    ' : '[out of scope]'} worktree=${row.worktree_id ?? '(null)'}  pane=${row.pane_key}  last state=${row.last_state}  ${fmtAge(row.last_seen_at)}  x${row.seen_count}`)
    }
  })
}

function cmdScope(sub, arg) {
  if (sub === 'unscoped') {
    if (arg !== 'on' && arg !== 'off') die('Usage: owb scope unscoped on|off')
    updateConfig((raw) => {
      raw.collector.scope.includeUnscoped = arg === 'on'
    })
    console.log(`includeUnscoped = ${arg === 'on'}`)
    return
  }
  if (sub !== 'add' && sub !== 'remove') die('Usage: owb scope add|remove --worktree <id> | --pane <key>')
  const key = values.worktree ? 'worktreeIds' : values.pane ? 'paneKeys' : null
  const value = values.worktree ?? values.pane
  if (!key) die('Specify --worktree or --pane')
  updateConfig((raw) => {
    const list = raw.collector.scope[key] ?? []
    raw.collector.scope[key] = sub === 'add' ? [...new Set([...list, value])] : list.filter((entry) => entry !== value)
  })
  console.log(`${sub === 'add' ? 'Added' : 'Removed'}: ${key} ${value}`)
}

function cmdLink(streamId, issueId, identifier) {
  if (!streamId || !issueId || !identifier) die('Usage: owb link <streamId> <linearIssueId> <DEV-123>')
  updateConfig((raw) => {
    raw.context ??= {}
    raw.context.linearIssueByStreamId ??= {}
    raw.context.linearIssueByStreamId[streamId] = { id: issueId, identifier }
  })
  console.log(`Linked ${streamId} -> ${identifier} (applies to events from now on)`)
}

function cmdUnlink(streamId) {
  if (!streamId) die('Usage: owb unlink <streamId>')
  updateConfig((raw) => {
    delete raw.context?.linearIssueByStreamId?.[streamId]
  })
  console.log(`Unlinked ${streamId}`)
}

function cmdProvider(paneKey, provider) {
  if (!paneKey || (!provider && !values.clear)) die('Usage: owb provider <paneKey> <claude_code|codex|...> | --clear')
  updateConfig((raw) => {
    raw.context ??= {}
    raw.context.providerByPaneKey ??= {}
    if (values.clear) delete raw.context.providerByPaneKey[paneKey]
    else raw.context.providerByPaneKey[paneKey] = provider
  })
  console.log(values.clear ? `Cleared ${paneKey}` : `Set ${paneKey} -> ${provider} (clear it when the pane is reused)`)
}

function cmdStreams() {
  withOutbox(({ db }, { config }) => {
    const rows = db.prepare('SELECT * FROM source_state ORDER BY updated_at DESC').all()
    for (const row of rows) {
      const issue = config.context.linearIssueByStreamId[row.stream_id]?.identifier
      const target = row.kind === 'agent' ? `worktree=${row.worktree_id ?? '(null)'} pane=${row.pane_key}` : 'Bridge lifecycle'
      console.log(`${row.stream_id}  ${target}  last=${row.last_state ?? '-'}  next seq=${row.next_sequence}${row.gap_pending ? '  (collection gap)' : ''}${issue ? `  [${issue}]` : ''}  ${fmtAge(row.last_observed_at)}`)
    }
    if (rows.length === 0) console.log('No streams yet.')
  })
}

function cmdEvents() {
  const limit = Number(values.limit ?? 30)
  withOutbox(({ db }) => {
    const rows = values.status
      ? db.prepare('SELECT * FROM outbox_events WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(values.status, limit)
      : db.prepare('SELECT * FROM outbox_events ORDER BY created_at DESC LIMIT ?').all(limit)
    for (const row of rows) {
      const note = row.dead_reason ? `dead=${row.dead_reason}` : row.last_error ? `err=${row.last_error}` : ''
      console.log(`${row.event_id}  ${row.status.padEnd(14)} ${row.event_type.padEnd(21)} ${row.stream_id}#${row.sequence}  observed ${fmtTime(row.observed_at)}  attempts ${row.attempts}  ${note}`)
    }
    if (rows.length === 0) console.log('No matching events.')
  })
}

function cmdShow(eventId) {
  if (!eventId) die('Usage: owb show <eventId>')
  withOutbox(({ db }) => {
    const row = db.prepare('SELECT * FROM outbox_events WHERE event_id = ?').get(eventId)
    if (!row) die('Not found (it may have been delivered and aged out of retention)')
    console.log(`status=${row.status} attempts=${row.attempts} endpoint=${row.endpoint_id} sha256=${row.body_sha256}`)
    console.log(JSON.stringify(JSON.parse(Buffer.from(row.body).toString('utf8')), null, 2))
    for (const attempt of db.prepare('SELECT * FROM delivery_attempts WHERE event_id = ? ORDER BY id').all(eventId)) {
      console.log(`  #${attempt.attempt} ${fmtTime(attempt.started_at)} ${attempt.outcome} ${attempt.summary ?? ''}`)
    }
  })
}

function cmdAttempts() {
  const limit = Number(values.limit ?? 30)
  withOutbox(({ db }) => {
    for (const row of db.prepare('SELECT * FROM delivery_attempts ORDER BY id DESC LIMIT ?').all(limit)) {
      console.log(`${fmtTime(row.started_at)}  ${row.event_id}  #${row.attempt}  ${row.outcome}  ${row.summary ?? ''}`)
    }
  })
}

function setControls(pairs, message) {
  withOutbox(({ db }) => transaction(db, () => pairs.forEach(([key, value]) => setControl(db, key, value))))
  console.log(message)
}

function cmdTestEvent() {
  withOutbox((outbox, { config }) => {
    const result = recordLifecycle(outbox, { config, reason: 'manual_test', detail: { origin: 'owb_cli' } })
    if (result.outcome !== 'recorded') die(`Could not queue: ${result.outcome} ${result.fault?.detail ?? ''}`)
    console.log(`Queued test event ${result.eventId} (${config.mode === 'dry_run' ? 'dry run: it will not be sent' : 'waiting to be sent'})`)
  })
}

function cmdRequeue(ids) {
  withOutbox(({ db }) => {
    const now = Date.now()
    let changes = 0
    transaction(db, () => {
      // Manual requeue is the user's decision, so it also lifts the age-based expiry.
      const requeue = db.prepare(
        `UPDATE outbox_events SET status = 'pending', next_attempt_at = ?, dead_reason = NULL, expiry_override = 1, updated_at = ?
         WHERE event_id = ? AND status IN ('dead_letter', 'dry_run', 'blocked_config')`
      )
      if (values['dead-letters']) {
        changes += db
          .prepare(
            `UPDATE outbox_events SET status = 'pending', next_attempt_at = ?, dead_reason = NULL, expiry_override = 1, updated_at = ?
             WHERE status = 'dead_letter' AND COALESCE(dead_reason, '') <> 'conflict_409'`
          )
          .run(now, now).changes
      }
      if (values['dry-run-events']) {
        changes += db.prepare("UPDATE outbox_events SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'dry_run'").run(now, now).changes
      }
      for (const id of ids) changes += requeue.run(now, now, id).changes
    })
    console.log(`Requeued ${changes} event(s). They are resent with the same event_id and body; the receiver deduplicates.`)
    if (values['dead-letters']) console.log('Dead letters from ID conflicts (409) are skipped; requeue them by event_id after investigating.')
  })
}

function cmdDiscard(ids) {
  if (ids.length === 0) die('Usage: owb discard <eventId...>')
  withOutbox(({ db }) => {
    let changes = 0
    transaction(db, () => {
      const stmt = db.prepare("DELETE FROM outbox_events WHERE event_id = ? AND status IN ('dead_letter', 'dry_run')")
      for (const id of ids) changes += stmt.run(id).changes
    })
    console.log(`Deleted ${changes} event(s) (only dead-letter / dry-run events can be deleted).`)
  })
}

function cmdEndpoint(sub) {
  if (sub !== 'confirm') die('Usage: owb endpoint confirm')
  withOutbox(({ db }, { config }) => {
    const { endpointId, endpointUrl } = config.sender
    const row = db.prepare('SELECT * FROM endpoints WHERE endpoint_id = ?').get(endpointId)
    if (!row || row.url === endpointUrl) {
      console.log('No URL change is waiting for approval.')
      return
    }
    const now = Date.now()
    const moved = transaction(db, () => {
      db.prepare(
        'UPDATE endpoints SET url = ?, pending_url = NULL, paused_kind = NULL, paused_reason = NULL, paused_at = NULL, recheck_at = NULL, updated_at = ? WHERE endpoint_id = ?'
      ).run(endpointUrl, now, endpointId)
      db.prepare("UPDATE outbox_events SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE endpoint_id = ? AND status = 'blocked_config'").run(now, now, endpointId)
      return db.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE endpoint_id = ? AND status IN ('pending', 'retry_wait')").get(endpointId).n
    })
    console.log(`Endpoint ${endpointId} URL changed: ${row.url} -> ${endpointUrl}. ${moved} undelivered event(s) will go to the new URL.`)
  })
}

function cmdReassign() {
  const from = values.from
  if (!from) die('Usage: owb reassign --from <endpointId>')
  withOutbox(({ db }, { config }) => {
    const to = config.sender.endpointId
    if (from === to) die('Source and target endpoint are the same')
    const changes = db
      .prepare("UPDATE outbox_events SET endpoint_id = ?, status = CASE status WHEN 'blocked_config' THEN 'pending' ELSE status END, updated_at = ? WHERE endpoint_id = ? AND status IN ('pending', 'retry_wait', 'blocked_config')")
      .run(to, Date.now(), from).changes
    console.log(`Moved ${changes} event(s) from ${from} to ${to} (${config.sender.endpointUrl}).`)
  })
}

function cmdLaunchAgent(sub) {
  const plistPath = launchAgentPath(home)
  const uid = process.getuid()
  if (sub === 'print' || sub === 'install') {
    ensurePrivateDir(bridgeDir(home))
    ensurePrivateDir(logsDir(home))
    const plist = renderLaunchAgentPlist({
      nodePath: process.execPath,
      senderScript: join(repoRoot, 'sender', 'main.mjs'),
      logFile: join(logsDir(home), 'sender.launchd.log'),
      workingDirectory: bridgeDir(home)
    })
    if (sub === 'print') {
      process.stdout.write(plist)
      return
    }
    mkdirSync(dirname(plistPath), { recursive: true })
    try {
      execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: 'ignore' })
    } catch {
      // Not loaded yet.
    }
    writeFileSync(plistPath, plist, { mode: 0o644 })
    execFileSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
    console.log(`Registered the LaunchAgent: ${plistPath}
  Node: ${process.execPath} (re-run this after switching Node versions, e.g. with nvm)
  Log:  ${join(logsDir(home), 'sender.log')}`)
    return
  }
  if (sub === 'uninstall') {
    try {
      execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: 'ignore' })
    } catch {
      // Not loaded.
    }
    rmSync(plistPath, { force: true })
    console.log('Removed the LaunchAgent (the queue and config are kept).')
    return
  }
  die('Usage: owb launchagent install|uninstall|print')
}

const [command, sub, ...rest] = positionals
switch (command) {
  case 'init':
    cmdInit()
    break
  case 'secret':
    await cmdSecret(sub)
    break
  case 'config':
    if (sub !== 'check') die('Usage: owb config check')
    cmdConfigCheck()
    break
  case 'status':
    cmdStatus()
    break
  case 'targets':
    cmdTargets()
    break
  case 'scope':
    cmdScope(sub, rest[0])
    break
  case 'link':
    cmdLink(sub, rest[0], rest[1])
    break
  case 'unlink':
    cmdUnlink(sub)
    break
  case 'provider':
    cmdProvider(sub, rest[0])
    break
  case 'enable':
  case 'disable':
    updateConfig((raw) => {
      raw.enabled = command === 'enable'
    })
    console.log(`config.enabled = ${command === 'enable'}`)
    break
  case 'mode':
    if (sub !== 'dry_run' && sub !== 'live') die('Usage: owb mode dry_run|live')
    updateConfig((raw) => {
      raw.mode = sub
    })
    console.log(`mode = ${sub}${sub === 'live' ? ' (events saved during dry run are not sent; use owb requeue --dry-run-events if you want them)' : ''}`)
    break
  case 'streams':
    cmdStreams()
    break
  case 'events':
    cmdEvents()
    break
  case 'show':
    cmdShow(sub)
    break
  case 'attempts':
    cmdAttempts()
    break
  case 'stop':
    setControls(
      [
        ['collector_enabled', '0'],
        ['sender_enabled', '0']
      ],
      'Bridge stopped: collection and new sends are paused, the queue is kept. An event that was in flight may already have reached the receiver.'
    )
    break
  case 'start':
    setControls(
      [
        ['collector_enabled', '1'],
        ['sender_enabled', '1']
      ],
      'Bridge resumed.'
    )
    break
  case 'collector':
    if (sub !== 'enable' && sub !== 'disable') die('Usage: owb collector enable|disable')
    setControls(
      [['collector_enabled', sub === 'enable' ? '1' : '0']],
      sub === 'enable' ? 'Collector resumed.' : 'Collector stopped. Queued events are still being sent (use owb stop to stop everything).'
    )
    break
  case 'sender':
    if (sub !== 'pause' && sub !== 'resume') die('Usage: owb sender pause|resume')
    setControls(
      [['sender_enabled', sub === 'resume' ? '1' : '0']],
      sub === 'resume' ? 'Sender resumed.' : 'Sender paused. Collection continues and events accumulate in the queue.'
    )
    break
  case 'test-event':
    cmdTestEvent()
    break
  case 'requeue':
    cmdRequeue([sub, ...rest].filter(Boolean))
    break
  case 'discard':
    cmdDiscard([sub, ...rest].filter(Boolean))
    break
  case 'endpoint':
    cmdEndpoint(sub)
    break
  case 'reassign':
    cmdReassign()
    break
  case 'launchagent':
    cmdLaunchAgent(sub)
    break
  case undefined:
  case 'help':
  case '--help':
    console.log(HELP)
    break
  default:
    die(`Unknown command: ${command}\n\n${HELP}`, 2)
}
