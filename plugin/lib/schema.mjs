// Minimal declarative validator shared by the config, Orca payload and
// envelope checks. Zero dependencies so the same file runs inside the Orca
// plugin worker, the Sender and the Ingress.

export class SchemaError extends Error {
  constructor(path, message) {
    super(`${path || '(root)'}: ${message}`)
    this.name = 'SchemaError'
    this.path = path
  }
}

function fail(path, message) {
  throw new SchemaError(path, message)
}

function join(path, key) {
  return path ? `${path}.${key}` : String(key)
}

function string({ min = 0, max = Infinity, pattern, patternMessage } = {}) {
  return (value, path) => {
    if (typeof value !== 'string') fail(path, 'must be a string')
    if (value.length < min) fail(path, `must be at least ${min} characters`)
    if (value.length > max) fail(path, `must be at most ${max} characters`)
    if (pattern && !pattern.test(value)) fail(path, patternMessage ?? `must match ${pattern}`)
    return value
  }
}

function number({ min, max, int = false, positive = false } = {}) {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number')
    if (int && !Number.isInteger(value)) fail(path, 'must be an integer')
    if (positive && !(value > 0)) fail(path, 'must be positive')
    if (min !== undefined && value < min) fail(path, `must be >= ${min}`)
    if (max !== undefined && value > max) fail(path, `must be <= ${max}`)
    return value
  }
}

function boolean() {
  return (value, path) => {
    if (typeof value !== 'boolean') fail(path, 'must be a boolean')
    return value
  }
}

function literal(expected, message) {
  return (value, path) => {
    if (value !== expected) fail(path, message ?? `must be ${JSON.stringify(expected)}`)
    return value
  }
}

function oneOf(values) {
  return (value, path) => {
    if (!values.includes(value)) fail(path, `must be one of ${values.map((v) => JSON.stringify(v)).join(', ')}`)
    return value
  }
}

function array(item, { min = 0, max = Infinity, unique = false } = {}) {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, 'must be an array')
    if (value.length < min) fail(path, `must have at least ${min} items`)
    if (value.length > max) fail(path, `must have at most ${max} items`)
    const out = value.map((entry, index) => item(entry, join(path, index)))
    if (unique && new Set(out.map((entry) => JSON.stringify(entry))).size !== out.length) {
      fail(path, 'must not contain duplicates')
    }
    return out
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Object schema. `strict` rejects unknown keys (configs: catch typos);
 * non-strict keeps only declared keys (host payloads: tolerate newer fields
 * without forwarding them).
 */
function object(shape, { strict = true } = {}) {
  return (value, path) => {
    if (!isPlainObject(value)) fail(path, 'must be an object')
    if (strict) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) fail(join(path, key), 'is not a known key')
      }
    }
    const out = {}
    for (const [key, schema] of Object.entries(shape)) {
      const present = Object.hasOwn(value, key) && value[key] !== undefined
      if (!present) {
        if (schema.optional) {
          // Run the default through the schema so nested defaults apply too.
          if (schema.defaultValue !== undefined) out[key] = schema(structuredClone(schema.defaultValue), join(path, key))
          continue
        }
        fail(join(path, key), 'is required')
      }
      out[key] = schema(value[key], join(path, key))
    }
    return out
  }
}

function record(valueSchema, { max = Infinity, keyPattern } = {}) {
  return (value, path) => {
    if (!isPlainObject(value)) fail(path, 'must be an object')
    const entries = Object.entries(value)
    if (entries.length > max) fail(path, `must have at most ${max} entries`)
    const out = {}
    for (const [key, entry] of entries) {
      if (keyPattern && !keyPattern.test(key)) fail(join(path, key), `key must match ${keyPattern}`)
      out[key] = valueSchema(entry, join(path, key))
    }
    return out
  }
}

function optional(schema, defaultValue) {
  const wrapped = (value, path) => schema(value, path)
  wrapped.optional = true
  wrapped.defaultValue = defaultValue
  return wrapped
}

function nullable(schema) {
  return (value, path) => (value === null ? null : schema(value, path))
}

export const s = { string, number, boolean, literal, oneOf, array, object, record, optional, nullable }

export function validate(schema, value) {
  return schema(value, '')
}
