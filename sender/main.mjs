#!/usr/bin/env node
// Orca Webhook Bridge — Sender daemon. Normally started by the user's
// LaunchAgent (`owb launchagent install`); also runnable in a terminal.
//   node sender/main.mjs            # logs to stdout and logs/sender.log
//   node sender/main.mjs --daemon   # logs only to logs/sender.log (launchd)

import { setTimeout as sleep } from 'node:timers/promises'
import { createLogger } from '../lib/logger.mjs'
import { logsDir } from '../plugin/lib/paths.mjs'
import { TICK_MS, createSender } from './sender.mjs'

const daemon = process.argv.includes('--daemon')
const log = createLogger({ dir: logsDir(), name: 'sender', echo: !daemon })
const sender = createSender({ log })
let stopping = false

async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log.info(`${signal} received; finishing in-flight sends`)
  await Promise.race([sender.drain(), sleep(5000)])
  sender.close()
  log.info('sender stopped')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

log.info(`sender ${sender.instanceId} starting (pid ${process.pid})`)
let lastStatus = null
while (!stopping) {
  try {
    const status = await sender.tick()
    if (status !== lastStatus) log.info(`state: ${status}`)
    lastStatus = status
  } catch (error) {
    log.error(`tick failed: ${error.stack ?? error.message}`)
  }
  await sleep(TICK_MS)
}
