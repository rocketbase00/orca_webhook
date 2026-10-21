import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig, parseConfig } from '../plugin/lib/config.mjs'
import { isInScope } from '../plugin/lib/normalize.mjs'

const base = () => defaultConfig({ deviceId: 'macbook-air-01' })

test('default config is valid, disabled, dry-run, with an empty scope', () => {
  const config = parseConfig(base())
  assert.equal(config.enabled, false)
  assert.equal(config.mode, 'dry_run')
  assert.deepEqual(config.collector.scope.worktreeIds, [])
  assert.deepEqual(config.collector.scope.paneKeys, [])
})

test('omitted nested sections get their nested defaults', () => {
  const raw = base()
  delete raw.queue
  delete raw.context
  delete raw.sender.retry
  const config = parseConfig(raw)
  assert.equal(config.queue.maxUndeliveredEvents, 100000)
  assert.equal(config.queue.maxPayloadBytes, 16384)
  assert.deepEqual(config.context.providerByPaneKey, {})
  assert.equal(config.sender.retry.initialDelaySeconds, 5)
})

test('includeTranscript=true and actions.enabled=true are refused', () => {
  const transcript = base()
  transcript.collector.includeTranscript = true
  assert.throws(() => parseConfig(transcript), /includeTranscript/)
  const actions = base()
  actions.actions.enabled = true
  assert.throws(() => parseConfig(actions), /actions\.enabled/)
})

test('inline secrets and secret-looking keys are refused', () => {
  const inline = base()
  inline.sender.signing.secret = 'abc'
  assert.throws(() => parseConfig(inline), /secrets must not be stored/)
  const badRef = base()
  badRef.sender.signing.secretRef = '0123456789abcdef0123456789abcdef'
  assert.throws(() => parseConfig(badRef), /secretRef/)
})

test('endpoint URL must be https on an allowed host, without credentials or redirects', () => {
  const http = base()
  http.sender.endpointUrl = 'http://hermes-host.example-tailnet.ts.net/bridge/v1/events'
  assert.throws(() => parseConfig(http), /https/)
  const loopback = base()
  loopback.sender.endpointUrl = 'http://127.0.0.1:8645/bridge/v1/events'
  loopback.sender.allowedHosts = ['127.0.0.1']
  assert.doesNotThrow(() => parseConfig(loopback))
  const otherHost = base()
  otherHost.sender.endpointUrl = 'https://evil.example.com/bridge/v1/events'
  assert.throws(() => parseConfig(otherHost), /allowedHosts/)
  const creds = base()
  creds.sender.endpointUrl = 'https://user:pw@hermes-host.example-tailnet.ts.net/x'
  assert.throws(() => parseConfig(creds), /credentials/)
  const redirects = base()
  redirects.sender.followRedirects = true
  assert.throws(() => parseConfig(redirects), /redirects/)
})

test('unknown keys are rejected to catch typos', () => {
  const raw = base()
  raw.collector.scop = {}
  assert.throws(() => parseConfig(raw), /scop: is not a known key/)
})

test('scope: empty collects nothing, null worktree needs includeUnscoped, both lists must match (A01, A05)', () => {
  const empty = { worktreeIds: [], paneKeys: [], includeUnscoped: true }
  assert.equal(isInScope(empty, 'wt-1', 'pane-a'), false)
  const panes = { worktreeIds: [], paneKeys: ['pane-a'], includeUnscoped: false }
  assert.equal(isInScope(panes, 'wt-1', 'pane-a'), true)
  assert.equal(isInScope(panes, 'wt-1', 'pane-b'), false)
  assert.equal(isInScope(panes, null, 'pane-a'), false)
  assert.equal(isInScope({ ...panes, includeUnscoped: true }, null, 'pane-a'), true)
  const both = { worktreeIds: ['wt-1'], paneKeys: ['pane-a'], includeUnscoped: false }
  assert.equal(isInScope(both, 'wt-1', 'pane-a'), true)
  assert.equal(isInScope(both, 'wt-2', 'pane-a'), false)
  assert.equal(isInScope(both, 'wt-1', 'pane-b'), false)
})
