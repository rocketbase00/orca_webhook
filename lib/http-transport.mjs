import http from 'node:http'
import https from 'node:https'

// One-shot POST with a separate connect timeout, an overall deadline, no
// redirect following (node:http never follows) and a bounded response body.
// Result `phase` tells the caller whether the request could have reached the
// server: errors before "sent" mean it certainly did not.

const TLS_ERROR_RE = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/

export function isTlsErrorCode(code) {
  return typeof code === 'string' && TLS_ERROR_RE.test(code)
}

export function postOnce(urlString, { headers, body, connectTimeoutMs, requestTimeoutMs, maxResponseBytes = 64 * 1024 }) {
  const url = new URL(urlString)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve) => {
    let phase = 'connect'
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(deadline)
      resolve(result)
    }
    const req = client.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': body.length },
      agent: false,
      rejectUnauthorized: true
    })
    const connectTimer = setTimeout(() => {
      req.destroy(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' }))
    }, connectTimeoutMs)
    const deadline = setTimeout(() => {
      req.destroy(Object.assign(new Error('request timeout'), { code: 'REQUEST_TIMEOUT' }))
    }, requestTimeoutMs)
    req.on('socket', (socket) => {
      const connected = () => {
        clearTimeout(connectTimer)
        phase = 'sent'
      }
      if (url.protocol === 'https:') socket.once('secureConnect', connected)
      else if (socket.connecting) socket.once('connect', connected)
      else connected()
    })
    req.on('error', (error) => {
      const code = error.code ?? 'UNKNOWN'
      finish({
        kind: 'error',
        phase: isTlsErrorCode(code) ? 'tls' : phase,
        code,
        message: error.message
      })
    })
    req.on('response', (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > maxResponseBytes) {
          res.destroy()
          finish({ kind: 'response', status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: true })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => finish({ kind: 'response', status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: false }))
      res.on('error', (error) => finish({ kind: 'error', phase: 'sent', code: error.code ?? 'RESPONSE_ERROR', message: error.message }))
    })
    req.end(body)
  })
}
