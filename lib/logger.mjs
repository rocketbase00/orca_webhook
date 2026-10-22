import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Line logger with size-based rotation for the long-running Sender/Ingress.
// Callers must never pass secrets, auth headers or event bodies.

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

export function createLogger({ dir = null, name, echo = true } = {}) {
  const file = dir ? join(dir, `${name}.log`) : null
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })

  function rotate() {
    try {
      if (statSync(file).size < MAX_BYTES) return
    } catch {
      return
    }
    for (let index = KEEP - 1; index >= 1; index--) {
      const from = `${file}.${index}`
      if (existsSync(from)) renameSync(from, `${file}.${index + 1}`)
    }
    renameSync(file, `${file}.1`)
  }

  function write(level, message) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`
    if (echo) (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)
    if (!file) return
    try {
      rotate()
      appendFileSync(file, `${line}\n`, { mode: 0o600 })
      chmodSync(file, 0o600)
    } catch {
      // Logging must never take the process down.
    }
  }

  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message)
  }
}
