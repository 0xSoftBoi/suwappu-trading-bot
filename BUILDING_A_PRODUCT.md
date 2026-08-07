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

## Keep two economics ledgers

Never present builder revenue as customer trading profit.

For the business, track contribution margin separately:

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

## What to build next

### 1. Make the signal worth keeping

The repo's reference price threshold is intentionally trivial. Before claiming strategy value, add evidence: historical evaluation, realistic costs, out-of-sample validation, and a dry-run period. Record why a decision happened so the user can evaluate it.

For full strategy research, [Freqtrade](https://www.freqtrade.io/en/stable/strategy-101/) is a better benchmark than bloating this repo: it treats backtesting and dry-run as distinct validation stages and documents stop-loss/protection machinery.

### 2. Add exits and risk as first-class state

A buy trigger is not a strategy lifecycle. Real strategy software usually needs position state, exits, stop-loss or equivalent risk rules, sizing, portfolio constraints, and fee-aware accounting. If you need multi-order orchestration, [Hummingbot Strategy V2](https://hummingbot.org/strategies/v2-strategies/) is a useful architecture benchmark because Executors own finite order lifecycles.

### 3. Upgrade state before horizontal scale

This reference uses an atomic local JSON journal and assumes one process owns it. Before multiple workers or replicas:

- move intents to transactional durable storage;
- enforce uniqueness for idempotency/economic-action keys;
- serialize or lock conflicting actions;
- preserve unresolved records indefinitely or with an explicit, audited resolution process;
- make reconciliation a durable background job;
- alert on stale `submitting` / `outcome_unknown` states.

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

## A good first paid experiment

Keep it deliberately small:

1. Pick one asset pair / user job and stay preview-only.
2. Let a handful of users create targets and receive route-qualified alerts.
3. Measure whether they return and whether the alerts change decisions.
4. Add an approval workflow for users who want action from the same context.
5. Enable bounded automation only for users who explicitly ask for it, with durable outcome handling and hard limits.
6. Price the workflow only after you know which part saves users meaningful time or reduces operational friction.

The goal is not “more bot.” The goal is a small workflow people trust enough to keep using—and, eventually, to pay for.
