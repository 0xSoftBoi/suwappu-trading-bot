# Changelog

Notable changes to the standalone product are recorded here.

## 2.0.0 - 2026-08-07

### Added

- Exclusive local money-moving/reconciliation lock with ownership-safe release.
- Atomic, fsynced, owner-only execution journal and soft resolved-record retention.
- Configurable bounded Suwappu operation deadline and metadata-only API events.
- One-shot preview mode and safe one-shot package/container defaults.
- Frozen Bun dependency graph, standalone build, dependency audit, container CI, and CodeQL.
- Operations runbook and contributor money-path review contract.

### Changed

- Critical price, quote, simulation, managed-execute, and status responses now fail closed on protocol/binding mismatches.
- HTTP 408, 5xx, transport failures, and malformed successful managed-execute responses are treated as outcome-unknown when a side effect may have begun.
- Upstream HTTP response bodies are no longer surfaced in adapter error messages.
- Python companion remains preview-only but now has bounded deadlines, `--once`, and matching quote-pair validation.

### Security

- State directory/journal/lock permissions are hardened to `0700`/`0600`.
- Docker runs non-root with durable `/data` and no automatic restart.
- Unresolved idempotency records are never removed by retention.

## 1.1.0

- Added preview-first managed execution with simulation, durable economic intents, caller-owned idempotency, outcome-unknown recovery, reconciliation, final amount recording, and a client-side USDC cap.
