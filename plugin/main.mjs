// Orca Webhook Bridge — Collector (Orca plugin worker entry).
//
// Runs inside Orca's out-of-process plugin worker (plain Node, forked lazily
// on the first subscribed event and reaped when idle). It only validates,
// filters and durably stores `agent.status.changed` observations in the
// Bridge outbox. Network delivery is the separate Sender process (spec §3.2),
// so nothing here waits on the network or on Hermes.

import { createCollector } from './lib/collector.mjs'

let collector = null

export default function activate(orca) {
  const canNotify = orca.grantedCapabilities.includes('notifications:show')
  const notify = (title, body) => {
    if (!canNotify) return
    orca.host.call('notifications.show', { title: title.slice(0, 120), body: body.slice(0, 1000) }).catch((error) => {
      orca.log(`notification failed: ${error.message}`)
    })
  }

  collector = createCollector({ log: (message) => orca.log(message), notify })

  // Synchronous SQLite commit; the ack goes back to Orca only after it (or a visible failure).
  orca.events.on('agent.status.changed', (payload) => {
    collector.handleAgentStatus(payload)
  })

  orca.commands.register('webhook-bridge.status', () => {
    const status = collector.status()
    if (status.configured === false) {
      notify('Webhook Bridge', `Not configured: ${status.error ?? 'config.json is missing'}`)
    } else {
      const state = !status.enabled ? 'disabled (config)' : !status.collectorEnabled ? 'stopped (bridge stop)' : status.mode
      notify(
        'Webhook Bridge',
        `State: ${state} / undelivered ${status.counts.undelivered - status.counts.dry_run} / dead letters ${status.counts.dead_letter} / sending ${status.senderEnabled ? 'on' : 'paused'}`
      )
    }
    return status
  })

  orca.commands.register('webhook-bridge.stop', () => {
    collector.setBridgeRunning(false)
    notify('Webhook Bridge', 'Bridge stopped: collection and new sends are paused; the queue is kept')
    return { stopped: true }
  })

  orca.commands.register('webhook-bridge.resume', () => {
    collector.setBridgeRunning(true)
    notify('Webhook Bridge', 'Bridge resumed')
    return { stopped: false }
  })

  orca.commands.register('webhook-bridge.test-event', () => {
    const result = collector.recordTestEvent()
    notify('Webhook Bridge', result.outcome === 'recorded' ? `Test event queued (#${result.sequence})` : `Could not queue the test event: ${result.outcome}`)
    return result
  })
}

export function deactivate() {
  collector?.close()
  collector = null
}
