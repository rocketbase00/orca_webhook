# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Bridge Ingress no longer forwards a re-emitted unchanged state to Hermes.
  Orca can report the same state repeatedly (for example `done` again minutes
  later), which made Hermes run once per repeat. Only a state transition, or a
  state whose previous value is unknown, is forwarded now; repeats are still
  stored and projected.

## [0.1.0] - 2026-10-21

First public release. Implements Phase 1–2 of the [specification](docs/spec.md)
(collection and one-way signed delivery).

### Added

- Orca plugin (Collector) that validates and scope-filters `agent.status.changed`
  and commits it to a local SQLite outbox before acknowledging the event.
- Sender (LaunchAgent) with per-stream ordered, at-least-once delivery,
  Hermes-compatible HMAC V2 signatures, exponential backoff, reachability
  probing, resume detection, dry-run mode and heartbeats.
- Bridge Ingress for the receiving machine: signature and source checks, a
  durable inbox with a long-lived dedupe ledger, 409 quarantine for ID conflicts,
  stream projection that never rolls back, and optional forwarding to a Hermes
  webhook route.
- `owb` admin CLI.

[Unreleased]: https://github.com/rocketbase00/orca_webhook/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rocketbase00/orca_webhook/releases/tag/v0.1.0
