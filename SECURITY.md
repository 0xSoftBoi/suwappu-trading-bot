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
- network/timeout/5xx ambiguity is recorded as `outcome_unknown`, not assumed failure;
- a known swap ID is reconciled before a new economic action is allowed;
- `--max-trades` counts terminal success, not request submissions;
- client-side caps supplement, rather than replace, server-side wallet policies.

Regression tests should accompany any change to these invariants.

## Protect the execution journal

By default the TypeScript bot stores `execution-journal.json` under `~/.suwappu-trading-bot`; Docker Compose uses a persistent named volume. The journal is part of the safety boundary: deleting an unresolved idempotency key can turn recovery into a second economic action.

The local journal implementation assumes one writer. Do not point multiple replicas at the same JSON file. Use transactional storage and concurrency controls before horizontal scaling.

Back up or otherwise durably retain unresolved `submitting`, `submitted`, and `outcome_unknown` records. `executions --reconcile` is safe to automate because it polls known swap IDs only and never submits.

## Credentials and wallets

- Never commit `.env`, API keys, wallet credentials, or private keys.
- Use the least-privileged Suwappu key and a dedicated wallet for development.
- Apply restrictive server-side wallet policies and small limits before managed execution.
- Rotate a credential immediately if it is exposed.
- Treat logs and support bundles as sensitive when they contain wallet or transaction data.

## Coordinated disclosure

We aim to acknowledge reports within 3 business days, triage severity within 7 business days, coordinate disclosure with the reporter, and provide credit unless anonymity is requested.

Good-faith research conducted without privacy violations, data destruction, or service degradation is covered by our safe-harbor intent. If in doubt, contact us before testing against live infrastructure.
