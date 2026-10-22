import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../plugin/lib/config.mjs'
import { queueCounts } from '../plugin/lib/outbox-db.mjs'
import { makeConfig, openTestOutbox, saveConfig, statusPayload, tempHome } from './helpers.mjs'

// Loads plugin/ through the plugin worker runtime shipped inside the locally
// installed Orca.app (forked as plain Node, exactly like Orca does), then
// drives it with the host↔worker protocol. Skipped when Orca is not installed.

const ORCA_BINARY = '/Applications/Orca.app/Contents/MacOS/Orca'
const HOST_ENTRY = '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/main/plugin-host-entry.js'
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin')
const available = existsSync(ORCA_BINARY) && existsSync(HOST_ENTRY)

function startWorker(home) {
  const child = fork(HOST_ENTRY, [], {
    execPath: ORCA_BINARY,
    env: { HOME: home, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' },
    execArgv: [],
    // Orca uses 'advanced', but the test runner's V8 may differ from Orca's; the messages are JSON-safe.
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const messages = []
  const waiters = []
  child.on('message', (message) => {
    if (message.type === 'hostCall') {
      child.send({ type: 'hostResult', callId: message.callId, ok: true, value: { delivered: true } })
    }
    messages.push(message)
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
    }
  })
  const waitFor = (match, timeoutMs = 10_000) => {
    const found = messages.find(match)
    if (found) return Promise.resolve(found)
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(messages.map((m) => m.type))}`)), timeoutMs)
      waiters.push({ match, resolve: (message) => (clearTimeout(timer), resolvePromise(message)) })
    })
  }
  return { child, messages, waitFor }
}

test('the plugin activates in Orca’s real worker runtime and persists events before acking', { skip: !available && 'Orca.app not installed' }, async (t) => {
  const home = tempHome(t)
  const raw = makeConfig(home)
  saveConfig(home, raw)
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'orca-plugin.json'), 'utf8'))
  const worker = startWorker(home)
  t.after(() => worker.child.kill('SIGKILL'))

  worker.child.send({
    type: 'init',
    pluginId: `${manifest.publisher}.${manifest.id}`,
    pluginRoot,
    mainEntry: manifest.main,
    grantedCapabilities: manifest.capabilities.map((capability) => capability.kind)
  })
  const ready = await worker.waitFor((m) => m.type === 'ready' || m.type === 'fatal')
  assert.equal(ready.type, 'ready', ready.error)
  assert.deepEqual(ready.commands.sort(), manifest.contributes.commands.map((c) => c.id).sort())

  worker.child.send({ type: 'deliverEvent', eventId: 0, event: 'agent.status.changed', payload: statusPayload({ state: 'working', receivedAt: 1 }) })
  worker.child.send({ type: 'deliverEvent', eventId: 1, event: 'agent.status.changed', payload: statusPayload({ state: 'waiting', receivedAt: 2 }) })
  await worker.waitFor((m) => m.type === 'eventAck' && m.eventId === 1)

  // By the time Orca receives the ack the rows are committed.
  const config = parseConfig(raw)
  const outbox = openTestOutbox(home, config)
  t.after(() => outbox.db.close())
  assert.equal(queueCounts(outbox.db).pending, 2)

  worker.child.send({ type: 'invokeCommand', callId: 0, commandId: 'webhook-bridge.status' })
  const status = await worker.waitFor((m) => m.type === 'commandResult' && m.callId === 0)
  assert.equal(status.ok, true)
  assert.equal(status.value.counts.pending, 2)
  assert.ok(worker.messages.some((m) => m.type === 'hostCall' && m.method === 'notifications.show'))

  worker.child.send({ type: 'shutdown' })
  const code = await new Promise((resolvePromise) => worker.child.once('exit', resolvePromise))
  assert.equal(code, 0)
})
