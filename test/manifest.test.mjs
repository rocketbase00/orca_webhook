import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PLUGIN_VERSION } from '../plugin/lib/version.mjs'

// Mirrors the Orca manifest rules checked on 2026-10-21 (plugin-manifest.ts,
// plugin-capabilities.ts): closed capability/event sets, ">=x.y.z" engines.

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin')
const manifest = JSON.parse(readFileSync(join(pluginRoot, 'orca-plugin.json'), 'utf8'))

const CAPABILITY_KINDS = ['workspace:read', 'terminal:send', 'notifications:show', 'storage', 'secrets', 'events:subscribe', 'settings:own']
const EVENT_NAMES = ['worktree.created', 'worktree.removed', 'agent.status.changed']

test('manifest matches the Orca v1 schema rules', () => {
  assert.equal(manifest.manifestVersion, 1)
  assert.equal(manifest.pluginApi, 1)
  assert.match(manifest.id, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.match(manifest.publisher, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.match(manifest.engines.orca, /^>=\d+\.\d+\.\d+$/)
  assert.ok(existsSync(join(pluginRoot, manifest.main)), 'worker entry exists inside the plugin root')
  for (const capability of manifest.capabilities) {
    assert.deepEqual(Object.keys(capability), ['kind'])
    assert.ok(CAPABILITY_KINDS.includes(capability.kind), capability.kind)
  }
  for (const event of manifest.contributes.events) assert.ok(EVENT_NAMES.includes(event.on), event.on)
  for (const command of manifest.contributes.commands) assert.match(command.id, /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
})

test('least privilege: no terminal, workspace, storage or secrets capability in the MVP (spec §17.2)', () => {
  const kinds = manifest.capabilities.map((capability) => capability.kind).sort()
  assert.deepEqual(kinds, ['events:subscribe', 'notifications:show'])
})

test('plugin version is in sync with the code', () => {
  assert.equal(manifest.version, PLUGIN_VERSION)
})
