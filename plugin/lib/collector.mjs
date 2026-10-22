import { homedir } from 'node:os'
import { recordAgentStatus, recordLifecycle } from './collector-core.mjs'
import { createConfigCache } from './config.mjs'
import {
  getControl,
  isCollectorEnabled,
  isSenderEnabled,
  openOutbox,
  queueCounts,
  recordConfigRevision,
  recordFault,
  setControl,
  transaction
} from './outbox-db.mjs'
import { configPath, resolveDirectoryRef } from './paths.mjs'

// Runtime wrapper around collector-core for the Orca plugin worker: config
// reloads, lazy outbox opening, and making collection failures visible
// (spec §8.3: never pretend an event was saved).

const NOTIFY_INTERVAL_MS = 10 * 60_000

export function createCollector({ home = homedir(), log = () => {}, notify = null, now = () => Date.now() } = {}) {
  const configCache = createConfigCache(configPath(home))
  const lastNotifiedAt = new Map()
  let outbox = null
  let lastConfigProblem = null
  let lastRevision = null
  let unrecordedWriteFailures = 0

  function alert(key, title, body) {
    log(`${title}: ${body}`)
    if (!notify) return
    const at = now()
    if (at - (lastNotifiedAt.get(key) ?? 0) < NOTIFY_INTERVAL_MS) return
    lastNotifiedAt.set(key, at)
    notify(title, body)
  }

  function loadConfig() {
    const loaded = configCache.get()
    if (!loaded.ok) {
      if (lastConfigProblem !== loaded.error) {
        lastConfigProblem = loaded.error
        if (loaded.missing) log(`${loaded.error} — run "owb init" to create it; nothing is collected until then`)
        else alert('config', 'Webhook Bridge: config error', `Collection is paused because config.json cannot be loaded: ${loaded.error}`.slice(0, 1000))
      }
      return null
    }
    lastConfigProblem = null
    return loaded
  }

  function ensureOutbox(loaded) {
    const dir = resolveDirectoryRef(loaded.config.queue.directoryRef, home)
    if (outbox && outbox.dir !== dir) {
      outbox.db.close()
      outbox = null
    }
    if (!outbox) outbox = openOutbox(dir, { nowMs: now() })
    if (lastRevision !== loaded.revision) {
      transaction(outbox.db, () => recordConfigRevision(outbox.db, loaded, 'collector', now()))
      lastRevision = loaded.revision
    }
    if (unrecordedWriteFailures > 0) {
      const count = unrecordedWriteFailures
      unrecordedWriteFailures = 0
      transaction(outbox.db, () => recordFault(outbox.db, { kind: 'write_failed', detail: `${count} event(s) could not be saved` }, now()))
    }
    return outbox
  }

  function withOutbox(fn) {
    const loaded = loadConfig()
    if (!loaded) return { ok: false, error: lastConfigProblem }
    return { ok: true, value: fn(ensureOutbox(loaded), loaded) }
  }

  return {
    handleAgentStatus(payload) {
      try {
        const result = withOutbox((box, loaded) => recordAgentStatus(box, { config: loaded.config, payload, nowMs: now() }))
        if (!result.ok) return { outcome: 'unconfigured' }
        const outcome = result.value
        if (outcome.fault) {
          alert(outcome.fault.kind, 'Webhook Bridge: collection fault', `${outcome.fault.kind}: ${outcome.fault.detail}. Undelivered events were kept.`)
        } else if (outcome.outcome === 'invalid') {
          log(`ignored malformed agent.status.changed payload: ${outcome.error}`)
        }
        return outcome
      } catch (error) {
        // The outbox itself is unusable: count it so the fault is persisted once writes work again.
        unrecordedWriteFailures += 1
        if (outbox) {
          try {
            outbox.db.close()
          } catch {
            // Already broken; reopen on the next event.
          }
          outbox = null
        }
        alert('write_failed', 'Webhook Bridge: write failed', `An event could not be saved to the outbox: ${error.message}`.slice(0, 1000))
        return { outcome: 'write_failed', error: error.message }
      }
    },

    /** Summary for the Orca command; the CLI (`owb status`) shows the full picture. */
    status() {
      const result = withOutbox((box, loaded) => {
        const counts = queueCounts(box.db)
        return {
          enabled: loaded.config.enabled,
          mode: loaded.config.mode,
          collectorEnabled: isCollectorEnabled(box.db),
          senderEnabled: isSenderEnabled(box.db),
          counts,
          lastEventAt: Number(getControl(box.db, 'collector_last_event_at', 0)) || null,
          senderHeartbeatAt: Number(getControl(box.db, 'sender_heartbeat_at', 0)) || null
        }
      })
      return result.ok ? result.value : { configured: false, error: result.error }
    },

    /** Whole-bridge stop/resume (spec §17.4): both collection and new sends; the queue is kept. */
    setBridgeRunning(running) {
      const result = withOutbox((box) =>
        transaction(box.db, () => {
          setControl(box.db, 'collector_enabled', running ? '1' : '0', now())
          setControl(box.db, 'sender_enabled', running ? '1' : '0', now())
        })
      )
      if (!result.ok) throw new Error(result.error ?? 'bridge is not configured')
    },

    recordTestEvent() {
      const result = withOutbox((box, loaded) =>
        recordLifecycle(box, { config: loaded.config, reason: 'manual_test', detail: { origin: 'orca_command' }, nowMs: now() })
      )
      if (!result.ok) throw new Error(result.error ?? 'bridge is not configured')
      return result.value
    },

    close() {
      outbox?.db.close()
      outbox = null
    }
  }
}
