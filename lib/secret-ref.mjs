import { execFile, spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

// Secret references: `keychain:<service>/<account>` (macOS login keychain via
// /usr/bin/security), `file:/abs/path` (0600, owned by the current user) and,
// for the Ingress only, `env:NAME`. Secret values are never logged.

const SECURITY = '/usr/bin/security'
export const MIN_SECRET_LENGTH = 32

export class SecretUnavailableError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SecretUnavailableError'
    this.code = code
  }
}

export function parseKeychainRef(ref) {
  const match = /^keychain:([^/\s]+)\/(\S+)$/.exec(ref)
  if (!match) throw new SecretUnavailableError('bad_ref', `not a keychain reference: ${ref}`)
  return { service: match[1], account: match[2] }
}

function checkSecret(value, ref) {
  if (value.length < MIN_SECRET_LENGTH) {
    throw new SecretUnavailableError('too_short', `secret for ${ref} is shorter than ${MIN_SECRET_LENGTH} characters`)
  }
  return value
}

function readKeychain(ref) {
  const { service, account } = parseKeychainRef(ref)
  return new Promise((resolve, reject) => {
    execFile(SECURITY, ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout.replace(/\r?\n$/, ''))
        return
      }
      const text = String(stderr)
      if (error.code === 44 || /could not be found/i.test(text)) {
        reject(new SecretUnavailableError('not_found', `keychain item ${service}/${account} not found`))
      } else if (/interaction is not allowed|locked/i.test(text)) {
        reject(new SecretUnavailableError('locked', 'keychain is locked'))
      } else {
        reject(new SecretUnavailableError('keychain_error', `keychain read failed (exit ${error.code ?? 'unknown'})`))
      }
    })
  })
}

function readSecretFile(ref) {
  const path = ref.slice('file:'.length)
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new SecretUnavailableError('not_found', `secret file not found: ${path}`)
  }
  if (!stat.isFile()) throw new SecretUnavailableError('bad_ref', `secret path is not a file: ${path}`)
  if ((stat.mode & 0o077) !== 0) throw new SecretUnavailableError('insecure_permissions', `secret file must be chmod 600: ${path}`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new SecretUnavailableError('insecure_permissions', `secret file must be owned by the current user: ${path}`)
  }
  return readFileSync(path, 'utf8').trim()
}

export async function resolveSecretRef(ref, { allowEnv = false } = {}) {
  if (ref.startsWith('keychain:')) return checkSecret(await readKeychain(ref), ref)
  if (ref.startsWith('file:')) return checkSecret(readSecretFile(ref), ref)
  if (allowEnv && ref.startsWith('env:')) {
    const value = process.env[ref.slice(4)]
    if (!value) throw new SecretUnavailableError('not_found', `environment variable ${ref.slice(4)} is not set`)
    return checkSecret(value, ref)
  }
  throw new SecretUnavailableError('bad_ref', `unsupported secret reference: ${ref}`)
}

/**
 * Stores a secret in the login keychain. The value goes through
 * `security -i` on stdin so it never appears in the process list.
 */
export function storeKeychainSecret(ref, secret) {
  const { service, account } = parseKeychainRef(ref)
  if (!/^[A-Za-z0-9._-]+$/.test(service) || !/^[A-Za-z0-9._-]+$/.test(account) || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    return Promise.reject(new Error('service, account and secret must be plain tokens'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 || /returned -?\d+/.test(output)) {
        reject(new Error(`security add-generic-password failed: ${output.replaceAll(secret, '***').trim()}`))
      } else {
        resolve()
      }
    })
    child.stdin.end(`add-generic-password -U -s ${service} -a ${account} -l "Orca Webhook Bridge (${account})" -w ${secret}\n`)
  })
}
