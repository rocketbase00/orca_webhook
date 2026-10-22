# Orca Webhook Bridge

[![test](https://github.com/rocketbase00/orca_webhook/actions/workflows/test.yml/badge.svg)](https://github.com/rocketbase00/orca_webhook/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**English** | [日本語](README.ja.md)

Forward [Orca](https://www.onorca.dev/) agent status changes (Claude Code, Codex, …) from your Mac to a [Hermes Agent](https://github.com/NousResearch/hermes-agent) running on another machine, without losing them when either side sleeps, goes offline or restarts.

An Orca plugin stores every in-scope `agent.status.changed` event in a local durable queue. A separate Sender delivers the queue over your Tailnet as HMAC-signed webhooks, and a small receiver on the Hermes machine stores, deduplicates and orders them before handing selected ones to Hermes.

> [!NOTE]
> This is an independent project, not affiliated with or endorsed by Stably AI (Orca) or Nous Research (Hermes Agent). Orca's plugin system is **experimental**; its API may change between Orca releases.

## Status

Version 0.1.0 implements Phase 1–2 of the [specification](docs/spec.md): collection and one-way signed delivery, the notification foundation. Forwarding to Hermes is limited to a rule-based filter. **Approved actions (Phase 4) are not implemented**, and the config refuses `actions.enabled: true`.

## How it works

```text
Mac                                                       Hermes machine
┌───────────────────────────────────────────┐            ┌──────────────────────────────────────┐
│ Orca ─agent.status.changed─▶ Collector     │            │ Bridge Ingress (ingress/)             │
│        (plugin/, Orca plugin worker)       │            │  signature + source checks            │
│              │ synchronous commit          │   HTTPS    │  durable inbox + dedupe ledger        │
│              ▼                             │  Tailscale │  per-stream ordering                  │
│        outbox.sqlite3 ──▶ Sender (sender/) ─┼───────────▶│              │ separate worker        │
│                   LaunchAgent, retries,    │  HMAC V2   │              ▼                        │
│                   signing, resume handling │            │  Hermes webhook route (optional)      │
│ owb (bin/) admin CLI                       │            │                                      │
└───────────────────────────────────────────┘            └──────────────────────────────────────┘
```

- **Saved before acknowledged.** The Collector commits each event to SQLite (WAL, `synchronous=FULL`) inside Orca's event handler and only then acks it. It never waits on the network.
- **At-least-once, deduplicated.** Every retry sends the same `event_id` and the same bytes with a fresh signature. The receiver deduplicates on `(device_id, epoch, event_id)` plus a body hash and quarantines conflicts with HTTP 409.
- **Ordered per stream.** One event per stream is in flight at a time. The receiver never lets an older sequence roll the current state back, and records gaps.
- **Sleep- and offline-aware.** When the receiver is unreachable, the Sender probes one event at a time with backoff. Offline ticks do not count as attempts. Resume, network changes and recovery release the waiting events right away.
- **Nothing is silently dropped.** A full queue stops collection and raises a visible fault. Events older than 30 days become dead letters for you to review. Old signatures are never reused.

## Repository layout

| Path | What it is |
| --- | --- |
| [`plugin/`](plugin) | **The Orca plugin (Collector).** Install this folder in Orca. Validates, scope-filters and stores events; no network access. |
| [`plugin/lib/`](plugin/lib) | Shared core: config validation, event envelope, SQLite outbox, HMAC V2 signing. |
| [`sender/`](sender) | Sender daemon run as a LaunchAgent: leasing, retries, probing, dry run, heartbeat. |
| [`ingress/`](ingress) | Bridge Ingress for the receiving machine. |
| [`bin/owb.mjs`](bin/owb.mjs) | `owb` admin CLI. |
| [`lib/`](lib) | Helpers for the Sender, Ingress and CLI (secret references, HTTP, logging, launchd plist). |
| [`examples/`](examples) | Example Mac config, Ingress config and Hermes route. |
| [`docs/spec.md`](docs/spec.md) | Design specification ([日本語](docs/spec.ja.md)). |

No npm dependencies: everything uses Node built-ins such as `node:sqlite`.

## Requirements

- macOS with Orca **1.4.232 or later**, with the plugin system turned on under *Settings → Plugins*
- **Node.js 24+** for the Sender, the CLI and the Ingress (for `node:sqlite`). The Collector runs on Orca's bundled Node, so it needs nothing extra.
- A network path from the Mac to the Hermes machine, such as [Tailscale](https://tailscale.com/)

## Setup on the Mac

```sh
git clone https://github.com/rocketbase00/orca_webhook.git
cd orca_webhook
alias owb="node $PWD/bin/owb.mjs"

# 1. Create the config and the outbox. It starts disabled, in dry-run mode, with nothing in scope.
owb init --device-id macbook-air-01 \
  --endpoint-url https://<hermes-host>.<tailnet>.ts.net/bridge/v1/events
#    Note the printed epoch: the receiver's sources[].epochs must list it.

# 2. Generate the signing key into the login Keychain and export a copy for the receiver.
owb secret generate --out ./bridge-key.txt   # 0600. Delete it once the receiver has it.
owb secret check                             # Prints a fingerprint to compare with the receiver.

# 3. Run the Sender as a LaunchAgent (starts at login, restarted after a crash).
owb launchagent install
```

4. **Install the plugin in Orca.** Open *Settings → Plugins*, turn the plugin system on, choose *Install plugin* → *Local folder*, and enter the absolute path of the `plugin/` folder in your clone. Review the requested capabilities (`events:subscribe`, `notifications:show`), then enable the plugin and consent. Orca copies the folder, so reinstall after updating `plugin/`.

5. **Choose what to collect.** An empty scope collects nothing.

   ```sh
   owb enable                      # config.enabled = true (still dry run)
   # run Claude Code / Codex in Orca
   owb targets                     # worktree IDs / pane keys seen so far (kept locally, never sent)
   owb scope add --pane <paneKey>  # or --worktree <worktreeId>
   owb status
   ```

6. **Check the dry run, then go live.** `owb attempts` should show `would POST ... signature ok`. Then switch with `owb mode live`. Events stored during the dry run are not sent unless you run `owb requeue --dry-run-events`.

The Orca command palette also has *Webhook Bridge: Show Status / Stop Bridge / Resume Bridge / Queue Test Event*.

## Setup on the Hermes machine

```sh
git clone https://github.com/rocketbase00/orca_webhook.git && cd orca_webhook   # Node.js 24+
mkdir -p ~/.config/orca-webhook-bridge && chmod 700 ~/.config/orca-webhook-bridge
install -m 600 bridge-key.txt ~/.config/orca-webhook-bridge/bridge-key-01.txt && rm bridge-key.txt
cp examples/ingress.config.example.json ~/.config/orca-webhook-bridge/ingress.config.json
#   edit keys[].secretRef, sources[].deviceId / epochs and dataDir
node ingress/main.mjs check-config   # the key fingerprint must match `owb secret check` on the Mac
node ingress/main.mjs serve          # listens on 127.0.0.1:8645; run it under systemd or similar
```

- The Ingress binds to `127.0.0.1` by default. To receive over HTTPS on your Tailnet, put `tailscale serve` (or another reverse proxy) in front of `http://127.0.0.1:8645`, or set `tls.certFile` / `tls.keyFile` and bind the Tailscale address. Binding `0.0.0.0` is refused unless you set `allowWildcardBind: true`.
- `allowedSourceCidrs` restricts client addresses. By default it allows loopback and the Tailscale ranges.
- To involve Hermes, enable `processing.forward` and create a webhook route based on [`examples/hermes-route.example.yaml`](examples/hermes-route.example.yaml). Only the latest observation of the selected states (default `waiting` and `done`) and collection faults are forwarded, and a state is forwarded only when it changes: Orca re-emits an unchanged state (for example `done` again minutes later), and those repeats are stored but not forwarded. Each forwarded event is marked with `historical` (observed more than 600 s ago by default) and with gap flags. Use a different key from the Mac → Ingress key.
- `node ingress/main.mjs status` shows sources, streams and the inbox. Reachability is `up` or `unknown`, based on heartbeats. A missing heartbeat is never reported as "asleep".

## Operations

```sh
owb status              # collection, sending, queue, endpoint, collection faults
owb stop / owb start    # stop the whole bridge (collection + new sends, queue kept) / resume
owb collector disable   # stop collecting only; queued events keep being sent
owb sender pause        # stop sending only; collection continues
owb events --status dead_letter
owb show <eventId>      # stored body and delivery attempts
owb requeue <eventId> | --dead-letters
owb discard <eventId>   # only dead-letter / dry-run events can be deleted
owb link <streamId> <linearIssueId> DEV-123   # explicit Linear issue link
owb endpoint confirm    # approve an endpoint URL change; queued events wait until you do
```

The Sender logs to `~/Library/Application Support/OrcaWebhookBridge/logs/sender.log` and keeps three rotated 5 MB files. The Collector logs to Orca's plugin log.

**Rotating the signing key** (spec §10.3): `owb secret generate` never overwrites an existing key. Set a new `sender.signing.keyId` and `secretRef` in `config.json` and generate the new key. Then add it to the Ingress `keys`, allow both keys in `sources[].keyIds`, confirm that delivery works, and set the old key to `enabled: false`. Event IDs and bodies do not change.

## Configuration

`owb init` writes `~/Library/Application Support/OrcaWebhookBridge/config.json` (see [`examples/config.example.json`](examples/config.example.json)). The file is validated as a whole before it is applied. The validator rejects:

- unknown keys and secrets written inline (only `secretRef` references are allowed)
- `includeTranscript: true` and `actions.enabled: true`
- following redirects
- non-HTTPS endpoints, except on loopback
- hosts outside `sender.allowedHosts`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` / `mode` | `false` / `dry_run` | Master switch; `dry_run` does everything except the POST. |
| `collector.scope` | empty | Worktree IDs / pane keys to collect. Empty means nothing. |
| `sender.endpointUrl`, `allowedHosts` | — | Receiver URL, pinned to an allow-list. |
| `sender.signing.secretRef` | `keychain:orca-webhook-bridge/<endpointId>` | `keychain:<service>/<account>` or `file:/abs/path` (0600). |
| `sender.responseContract` | `bridge_v1` | `hermes_webhook` sends directly to a Hermes built-in route instead of the Ingress. |
| `queue.maxUndeliveredEvents` / `maxDiskBytes` | 100,000 / 256 MiB | Above these, collection stops with a fault. Nothing is deleted. |
| `sender.retry.maxEventAgeDays` | 30 | Older undelivered events become `expired` dead letters. |

## What is sent

By default the bridge sends only states and identifiers (spec §18).

| Sent | Never sent |
| --- | --- |
| Raw and normalized `state`, previous state, raw `receivedAt`, `mainAgent` (`state`, `outcome`, `stateStartedAt`), `worktreeId`, `paneKey`, explicitly configured provider / Linear issue, device ID, epoch, stream sequence | Prompts, responses, terminal output, environment variables, API keys, notification text |

`worktreeId` and `paneKey` are sent as Orca reports them. Use `owb targets` to see what they contain in your setup.

## Delivery guarantees and limits

- An event counts as saved only after its outbox commit (spec §8.3). Some events are outside the guarantee: events Orca never delivers, crashes before the commit, and periods when the bridge is stopped or the pane is out of scope. When that happens, the next event's `previous_state` is `null` and the receiver records a sequence gap.
- `done` means only that the agent was observed as finished. It does not mean the work succeeded or the issue is complete. The bridge never updates Linear.
- The Collector cannot read the current state on demand, because Orca has no API for it. After a gap, the receiver shows the last observed state.

## Development

```sh
npm test   # node:test, no dependencies
```

The suite has 48 tests. [`test/orca-runtime.test.mjs`](test/orca-runtime.test.mjs) loads `plugin/` into the plugin worker runtime bundled in a locally installed `Orca.app`. It drives that runtime with Orca's host↔worker protocol: event delivery, a command and shutdown. It skips itself when Orca is not installed.

| Acceptance criteria (spec §20) | Status |
| --- | --- |
| A01, A03–A05, A07, A08, A13, A14, A16–A19, A21–A23, A25 | Covered by automated tests |
| A09–A12 | Simulated: outages, resume detection, lease reclaim and receiver downtime. Not yet checked with real sleep or reboot. |
| A02, A06, A15, A20, A24, A32 | Need real-device, long-running or Keychain-lock checks |
| A26–A31 | Not applicable: Phase 4 is not implemented |

<details>
<summary>Verification items (spec §21)</summary>

| ID | Status |
| --- | --- |
| V01 | Developed against Orca 1.4.232 (Electron 43.7.8). The bundled worker runtime matches the public source; the exact commit is not pinned. |
| V02 | Activation, event delivery, commands and shutdown are verified in the bundled worker runtime. Install, consent and disable/re-enable in the Orca UI are not yet verified. |
| V03 | Not verified. `receivedAt` is kept raw (`received_at_raw`) and never converted to a date. |
| V04 | The public API has no provider or session ID. The bridge sends `null`, with optional manual mapping (`owb provider`). |
| V05 | `node:sqlite` (WAL, transactions) works on Orca's bundled Node 24.21. |
| V06 | Orca reaps idle workers after 5 minutes, so the Sender is a separate process. |
| V07 | LaunchAgent and Keychain (`security`) are implemented, and sending is held while the Keychain is locked. Not yet checked on a real device. |
| V08 | Orca has no API for reading the current state, so the receiver shows the last observed state. |
| V09 | Matches Hermes' generic V2 signature (HMAC-SHA256 hex of `<timestamp>.<body>`) and `X-Request-ID` delivery IDs. Tested against Python's `hmac`. |
| V10–V14 | Not verified (Hermes permissions, Tailscale/SSH, action APIs, Orca panel control, Linear). |

</details>

Contributions are welcome. Please open an issue first for larger changes, and report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
