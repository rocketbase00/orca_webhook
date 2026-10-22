import { createHash } from 'node:crypto'

/** JSON with object keys sorted recursively, so equal values hash equally. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortKeys(value[key])
    }
    return out
  }
  return value
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}
