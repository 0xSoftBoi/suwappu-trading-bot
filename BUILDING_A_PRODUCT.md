# Turn the Trading Reference into a Product

The code in this repository is the beginning of a product boundary, not a business by itself. A raw “buy when a reference price is below X” signal is easy to copy. Builders create durable value by improving the user's decision, permission, execution, and outcome loop.

This guide is about product economics and engineering. It is not a claim that the example strategy is profitable.

## Start with a customer job

Pick one narrow user and one repeated problem before adding strategies. Examples:

- a power user wants to know when a wallet-executable route meets a price they care about;
- a small team wants approvals, limits, and an audit trail around recurring swaps;
- an agent builder wants a bounded execution primitive with recovery semantics it can call safely.

The useful unit is not “a signal fired.” It is “the user got from intent to a trustworthy outcome with less work or risk.”

## Product ladder

| Stage | User pays for | Suwappu surfaces | What you add |
|---|---|---|---|
| Monitor | Relevant, executable opportunities | prices + quote | watchlists, notification quality, routing-aware thresholds |
| Approval workspace | Faster decisions with context | quote + simulate | policy UI, approvals, explanations, audit history |
| Bounded automation | Repeated outcomes within explicit limits | quote + simulate + managed execute + status | durable intents, idempotency, reconciliation, budgets, alerts |

Do not jump straight to automation. A monitor can validate whether users care about the opportunity; an approval workflow can validate trust; only then does unattended execution deserve the operational burden.

The maintained CLI is useful at all three stages, but it intentionally stays a **single-node Suwappu execution boundary**, not a general trading framework. That focus is part of the product: builders can copy a small, testable authority model without inheriting a strategy engine they do not need.

## Activation and retention

A builder funnel can be measured without making trading-performance promises:

1. **Activation:** user creates a target and gets a wallet-executable preview.
2. **Trust:** user sees why a candidate was allowed or blocked, including minimum output and estimated gas.
3. **First outcome:** an opted-in user reaches a terminal managed-swap status and can inspect final amounts.
4. **Retention:** the user returns to the monitor/approval/execution workflow because it saves meaningful time or produces consistently useful decisions.

Useful product metrics include:

- activated workspaces / connected users;
- candidate → qualified-route rate;
- qualified-route → approval rate;
- simulation block rate and reasons;
- terminal success/failure/unknown-outcome rate;
- time from candidate to terminal outcome;
- weekly retained users or automated policies still intentionally enabled.

An `outcome_unknown` is an operational event worth measuring. Hiding it as “failed” or immediately creating a fresh trade makes both the product and the analytics less trustworthy.

## Know the call budget

Polling is part of your cost model. At the default 30-second interval, one always-on target makes up to 2,880 reference-price requests per day before any quote is requested.

The normal request path in this reference is:

| Situation | API work |
|---|---|
| Reference above target | 1 price request |
| Candidate, preview | price + quote |
| New managed candidate | price + quote + simulation + execute, then status polling as needed |
| Known pending swap | status only before a new economic action |
| Ambiguous submit without swap ID | fresh same-terms quote + simulation + same-key retry |

Model your actual Suwappu plan, infrastructure, notification, support, and payment costs before setting a price. Reduce unnecessary polling or aggregate work across users where your architecture and API contract safely allow it.

Put call/cost ceilings into each paid plan. A simple pricing worksheet for a monitor tier is:

```text
monthly API work per customer
= price polls
+ route qualifications
+ simulations
+ managed submissions
+ reconciliation polls

target gross contribution
= plan revenue
- Suwappu usage
- compute/storage/notifications
- payment/support/other variable costs
```

Do not optimize for raw request volume. The product metric is whether a user reaches a useful preview, decision, or reconciled outcome.

## Keep two economics ledgers

Never present builder revenue as customer trading profit.

For the business, track contribution margin separately and at the **plan/customer cohort** level:

```text
builder contribution margin
= subscription / usage revenue
- Suwappu API costs
- hosting + data + notification costs
- payment fees, support, and incentives
```

For the user's strategy, use execution outcomes and include real costs:

```text
customer strategy result
= realized strategy proceeds/value
- acquisition cost
- execution gas and other strategy costs
```

The exact trading-P&L ledger depends on the strategy, inventory accounting, taxes, and exit logic. This example does **not** implement those pieces, so it should not display an ROI or “profit” number as if it did.

## Monetization that maps to value

Test a price against the workflow you improve, for example:

- subscription for saved monitors, alerts, and history;
- team tier for approvals, roles, policies, and auditability;
- usage tier for bounded automated workflows and reconciliation volume;
- vertical product pricing when the workflow solves a specific recurring business problem.

Do not invent a protocol “builder fee” unless the actual contract you use supports it. If your product charges users, make that product charge explicit in your own billing and economics.

Reasonable fences are product capabilities rather than trading promises: saved targets/history, alert destinations, team approvals, audit retention, number of intentionally enabled automations, and support/SLA level. Never sell “higher returns” as a tier benefit unless you have a separately substantiated strategy product and the legal/compliance basis to make that claim.

## What to build next

### 1. Make the signal worth keeping

The repo's reference price threshold is intentionally trivial. Before claiming strategy value, add evidence: historical evaluation, realistic costs, out-of-sample validation, and a dry-run period. Record why a decision happened so the user can evaluate it.

For full strategy research, [Freqtrade's backtesting documentation](https://www.freqtrade.io/en/stable/backtesting/) is a better benchmark than bloating this repo. Its docs explicitly distinguish backtesting from dry-run/live evidence, and it provides dedicated [lookahead analysis](https://www.freqtrade.io/en/stable/lookahead-analysis/) plus [protections](https://www.freqtrade.io/en/stable/plugins/). If strategy validation is your differentiator, use that class of tooling rather than calling one successful Suwappu trade “evidence.”

### 2. Add exits and risk as first-class state

A buy trigger is not a strategy lifecycle. Real strategy software usually needs position state, exits, stop-loss or equivalent risk rules, sizing, portfolio constraints, and fee-aware accounting. If you need multi-order orchestration, [Hummingbot Strategy V2](https://hummingbot.org/strategies/v2-strategies/) is a useful architecture benchmark because its [Executors](https://hummingbot.org/strategies/v2-strategies/executors/) own finite order lifecycles.

### 3. Upgrade state before horizontal scale

Version 2 uses an exclusive local process lock plus an atomic, fsynced JSON journal with owner-only permissions. That gives one state directory one money-moving owner. It is deliberately **not** a distributed lock. Before multiple hosts or replicas:

- move intents to transactional durable storage;
- enforce uniqueness for idempotency/economic-action keys;
- serialize or lock conflicting actions;
- preserve unresolved records indefinitely or with an explicit, audited resolution process;
- make reconciliation a durable background job;
- alert on stale `submitting` / `outcome_unknown` states.

Keep the same fail-closed rule during migration: if old state cannot be proved complete and valid, do not create a new economic action.

### 4. Build permissions people can understand

Keep preview, approval, and managed submission visibly distinct. Expose limits in the product UI. Show the wallet, chain, asset, amount, minimum output, gas estimate, and reason for execution before permission is granted.

### 5. Close the outcome loop

Treat a submission response as a workflow state, not success. The durable product object should retain:

- user/business intent;
- economic terms and applicable limits;
- quote and simulation evidence;
- idempotency key;
- swap ID / transaction hash;
- terminal status;
- final input/output amounts;
- errors and operator resolution.

That auditability is useful to users even when the trading signal itself is simple.

## Enterprise graduation checklist

Treat “enterprise” as an operating contract, not a logo. Before selling this as a managed multi-user service, add the pieces that belong outside this single-node repo:

| Boundary | This repo provides | Multi-user service still needs |
|---|---|---|
| Financial authority | Preview default, two live gates, per-action cap, simulation | Tenant-scoped roles/approvals, aggregate/daily budgets, kill switch |
| Duplicate safety | Durable economic intent, same-key retry, local single-writer lock | Transactional uniqueness + distributed serialization |
| Outcome truth | `submitted` / `outcome_unknown` / terminal reconciliation | Durable reconciliation workers, alert ownership, incident queue |
| Observability | JSON output + metadata-only API timing/outcome events | Central metrics/logs/traces with tenant-safe retention |
| Release safety | Locked deps, tests/build/audit/container/CodeQL gates | Signed releases/SBOM/provenance according to your deployment policy |
| Strategy evidence | No profitability claim | Backtests/evals, dry-run, risk/exits, model/version attribution if sold |
| Business economics | Cost worksheet + product ladder | Per-plan metering, billing, support and measured contribution margin |

The [operations runbook](docs/OPERATIONS.md) covers the boundary that *is* maintained here.

## A good first paid experiment

Keep it deliberately small:

1. Pick one asset pair / user job and stay preview-only.
2. Let a handful of users create targets and receive route-qualified alerts.
3. Measure whether they return and whether the alerts change decisions.
4. Add an approval workflow for users who want action from the same context.
5. Enable bounded automation only for users who explicitly ask for it, with durable outcome handling and hard limits.
6. Price the workflow only after you know which part saves users meaningful time or reduces operational friction.

The goal is not “more bot.” The goal is a small workflow people trust enough to keep using—and, eventually, to pay for.
