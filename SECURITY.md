# Security Policy

Orca Webhook Bridge moves agent status data between machines and holds signing keys, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://github.com/rocketbase00/orca_webhook/security/advisories/new)
with a description, affected version or commit, and reproduction steps.
You should get a first response within a week.

## Supported versions

Only the latest release on `main` receives fixes while the project is at 0.x.

## Scope

In scope, for example:

- Bypassing HMAC verification, the timestamp window, or the source / epoch checks in the Ingress
- Leaking signing keys, auth headers or event bodies through logs, files or error responses
- Making the Collector send events that are outside the configured scope
- Causing silent loss of events that were reported as saved or accepted

Out of scope: vulnerabilities in Orca, Hermes Agent, Tailscale or Node.js themselves (report those upstream), and setups that ignore the documented defaults (for example binding the Ingress to `0.0.0.0` on a public network).
