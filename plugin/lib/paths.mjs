import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Bridge-owned locations (spec §8.1). Not an Orca storage location: the
// Collector, the Sender and the CLI all derive them from $HOME so the plugin
// worker (whose env is scrubbed down to HOME/PATH/...) agrees with the rest.

export const BRIDGE_DIR_NAME = 'OrcaWebhookBridge'
export const OUTBOX_FILENAME = 'outbox.sqlite3'

export function appSupportRoot(home = homedir()) {
  return join(home, 'Library', 'Application Support')
}

export function bridgeDir(home = homedir()) {
  return join(appSupportRoot(home), BRIDGE_DIR_NAME)
}

export function configPath(home = homedir()) {
  return join(bridgeDir(home), 'config.json')
}

export function logsDir(home = homedir()) {
  return join(bridgeDir(home), 'logs')
}

const DIRECTORY_REF_RE = /^user_application_support\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/

export function isValidDirectoryRef(ref) {
  return DIRECTORY_REF_RE.test(ref)
}

/** `user_application_support/<name>` → ~/Library/Application Support/<name>. Bridge notation, not Orca syntax. */
export function resolveDirectoryRef(ref, home = homedir()) {
  const match = DIRECTORY_REF_RE.exec(ref)
  if (!match) throw new Error(`unsupported directoryRef: ${ref}`)
  return join(appSupportRoot(home), match[1])
}

/** User-only directory (0700), created if missing and tightened if it exists. */
export function ensurePrivateDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
