# Security Policy

This repository is a Suwappu integration reference. The TypeScript entrypoint can submit real managed-wallet swaps only after explicit opt-in; the Python companion is preview-only.

## Report a vulnerability

Do not open a public issue for a security report. Use GitHub Private Vulnerability Reporting when enabled for this repository, or email **security@suwappu.bot**.

Include the affected file/version, reproduction steps, and impact. Issues in the Suwappu API, shared SDKs, custody layer, contracts, or core bot should be reported through the [core security policy](https://github.com/0xSoftBoi/suwappubot/security/policy).

## Money-moving invariants

Changes to managed execution should preserve all of these properties:

- preview is the default and cannot submit;
- managed mode requires both `--execute` and `SUWAPPU_ALLOW_MANAGED_EXECUTION=1`;
- the wallet-aware route must still meet the configured target using minimum output and estimated gas;
- `/swap/simulate` must explicitly return `would_execute: true`;
- an intent and idempotency key are durable before submission becomes ambiguous;
- retries for the same economic action reuse that idempotency key;
- network/timeout/HTTP 408/5xx or malformed-2xx ambiguity is recorded as `outcome_unknown`, not assumed failure;
- a known swap ID is reconciled before a new economic action is allowed;
- one local state directory has one managed/reconciliation owner through an exclusive lock;
- `--max-trades` counts terminal success, not request submissions;
- client-side caps supplement, rather than replace, server-side wallet policies.

Regression tests should accompany any change to these invariants.

## Protect the execution journal

By default the TypeScript bot stores `execution-journal.json` under `~/.suwappu-trading-bot`; Docker Compose uses a persistent named volume. The journal is part of the safety boundary: deleting an unresolved idempotency key can turn recovery into a second economic action. The state directory is forced to mode `0700`, journal/lock files to `0600`, and journal replacement is atomic after a file `fsync`.

Managed mode and `executions --reconcile` acquire `execution.lock` exclusively. A stale lock is intentionally **not** auto-deleted: prove the recorded process is gone before clearing it. Do not point multiple hosts/replicas at the same JSON directory; a local lock is not distributed consensus. Use transactional storage and concurrency controls before horizontal scaling.

Back up or otherwise durably retain unresolved `submitting`, `submitted`, and `outcome_unknown` records. `executions --reconcile` is safe to automate because it polls known swap IDs only and never submits.

## Network and telemetry boundary

- Every Suwappu operation has a bounded deadline (`SUWAPPU_OPERATION_TIMEOUT_MS`, default 25 seconds, maximum 30 seconds).
- Upstream HTTP response bodies are not copied into thrown/logged request errors by the TypeScript adapter or Python preview loop.
- Optional `SUWAPPU_API_EVENTS` telemetry contains only operation, transport/protocol outcome, duration, and HTTP status. It excludes credentials, wallet/market terms, quote/swap IDs, response bodies, and error text.
- Metadata events do not prove transaction success. Terminal managed outcomes still come from reconciliation.

## Credentials and wallets

- Never commit `.env`, API keys, wallet credentials, or private keys.
- Use the least-privileged Suwappu key and a dedicated wallet for development.
- Apply restrictive server-side wallet policies and small limits before managed execution.
- Rotate a credential immediately if it is exposed.
- Treat logs and support bundles as sensitive when they contain wallet or transaction data.

## Coordinated disclosure

We will coordinate remediation and disclosure with the reporter and provide credit unless anonymity is requested. Do not infer a response-time SLA from this repository; organization-level security commitments should be documented and staffed separately.

If testing could touch live funds, private data, or service availability, contact us before testing against production infrastructure.
