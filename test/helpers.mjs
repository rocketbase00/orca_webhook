import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../plugin/lib/config.mjs'
import { openOutbox } from '../plugin/lib/outbox-db.mjs'
import { configPath, ensurePrivateDir, bridgeDir, resolveDirectoryRef } from '../plugin/lib/paths.mjs'

export const TEST_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

export function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'owb-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

export function writeSecretFile(dir, name = 'secret.txt', value = TEST_SECRET) {
  const path = join(dir, name)
  writeFileSync(path, `${value}\n`, { mode: 0o600 })
  return path
}

/** A live-mode config scoped to pane-a/pane-b, signing with a file secret. */
export function makeConfig(home, overrides = {}) {
  const secretPath = writeSecretFile(home)
  const config = defaultConfig({ deviceId: 'macbook-air-01', endpointUrl: overrides.endpointUrl ?? 'http://127.0.0.1:9/bridge/v1/events' })
  config.enabled = true
  config.mode = 'live'
  config.collector.scope.paneKeys = ['pane-a', 'pane-b']
  config.collector.scope.includeUnscoped = true
  config.sender.signing.secretRef = `file:${secretPath}`
  config.sender.heartbeat.enabled = false
  config.queue.minFreeDiskBytes = 0
  return deepMerge(config, overrides.patch ?? {})
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') deepMerge(target[key], value)
    else target[key] = value
  }
  return target
}

export function saveConfig(home, config) {
  ensurePrivateDir(bridgeDir(home))
  writeFileSync(configPath(home), JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function openTestOutbox(home, config) {
  return openOutbox(resolveDirectoryRef(config.queue.directoryRef, home))
}

export function statusPayload(overrides = {}) {
  return { worktreeId: 'wt-1', paneKey: 'pane-a', state: 'working', receivedAt: 1792544400000, ...overrides }
}

/** Mutable clock shared by Sender and Ingress in tests. */
export function createClock(start = Date.now()) {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
    set(ms) {
      current = ms
    }
  }
}

export async function pump(sender, rounds = 5, clock = null, stepMs = 1000) {
  for (let index = 0; index < rounds; index++) {
    await sender.tick()
    await sender.drain()
    clock?.advance(stepMs)
  }
}
