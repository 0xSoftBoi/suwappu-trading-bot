# Operations Runbook

This runbook is for the standalone Suwappu Trading Bot v2. The product has one intentionally narrow money path: a USDC price target can qualify a wallet-aware quote, simulate it, and—only with two explicit live gates—submit through Suwappu's managed-wallet endpoint.

The strategy is an example. The operating invariants below are the product contract.

## Authority modes

| Mode | Reads prices/quotes | Simulates | Can submit | Durable money state |
|---|---:|---:|---:|---:|
| `--once` / default package or container start | Yes | No | No | No |
| Continuous preview (`bun run watch`) | Yes | No | No | No |
| Managed (`--execute` + env gate) | Yes | Yes | **Yes** | **Yes** |
| `executions --reconcile` | Status only | No | No new submission | **Yes** |

Managed mode additionally requires `SUWAPPU_WALLET_ADDRESS`. Keep restrictive server-side wallet policies in force: the local `SUWAPPU_MAX_TRADE_USDC` cap is defense in depth, not the wallet security boundary.

## Before live operation

1. Run the exact release in preview against the intended chain/pair and small amount.
2. Confirm the managed wallet, server-side policies/limits, gas funding, and Suwappu agent key.
3. Put `SUWAPPU_TRADING_BOT_STATE_DIR` on durable local storage. Back it up before upgrades.
4. Confirm `bun src/cli.ts executions` has no unresolved action you do not understand.
5. Confirm no stale `execution.lock` exists.
6. Set a deliberately small `SUWAPPU_MAX_TRADE_USDC` and `--max-trades`.
7. Enable `SUWAPPU_API_EVENTS=1` if your log sink can safely retain metadata events.
8. Start managed mode only after both live gates are intentionally present.

Do not put a managed command behind an unconditional restart loop. The supplied container is one-shot preview with `restart: "no"` for this reason.

## Durable state and single ownership

The state directory contains:

- `execution-journal.json`: economic intents, quote evidence, submission/reconciliation state, final amounts;
- `execution.lock`: exclusive local ownership for managed execution or a reconciliation write pass.

The directory is mode `0700`; journal and lock are mode `0600`. Journal replacement uses a unique temporary file, file `fsync`, atomic rename, and a best-effort directory `fsync`. Invalid/corrupt JSON fails closed before a new economic action is created.

`SUWAPPU_TRADING_BOT_JOURNAL_LIMIT` defaults to 5,000 records. It is a soft target: only failed or explicitly accounted records are eligible for pruning. Unresolved idempotency state is never discarded to satisfy retention.

### Stale lock recovery

The bot intentionally does not guess that a lock is stale.

1. Stop schedulers/restart supervisors for this state directory.
2. Read `execution.lock` and note its `pid` and `acquiredAt`.
3. Prove that process is no longer running and that no other host can be using this local directory.
4. Preserve a copy of the journal/lock as incident evidence.
5. Remove only that proven-stale `execution.lock`.
6. Run `bun src/cli.ts executions --reconcile` before managed mode.

If ownership cannot be proved, stop. Deleting uncertainty is not reconciliation.

For multiple replicas/hosts, move intents to a transactional datastore with a uniqueness constraint on the economic-action/idempotency key plus distributed serialization. Do not share this JSON directory over network storage and call it a distributed lock.

## Outcome-unknown recovery

Before `/swap/execute`, the bot persists `submitting` and uses the durable intent ID as `Idempotency-Key`. A timeout/network failure, HTTP 408/5xx, or malformed 2xx execute response can happen after side effects begin, so these cases are `outcome_unknown`.

Recovery rules:

- known `swapId`: status-reconcile that swap; never submit a new action;
- no `swapId`: retain the original economic terms and key, request a fresh same-terms quote, re-run simulation/guards, then reuse the **same** key;
- different economic terms: create a different action only after the unresolved original is resolved/accounted according to operator policy.

The Suwappu managed execution contract binds caller idempotency to economic terms rather than short-lived `quote_id`, so a fresh same-terms quote can represent the same retry.

If the process receives SIGINT/SIGTERM during submission, `submitting` was already persisted. A restart must treat it as ambiguous even if the operator believes the request “probably did not send.”

## Network deadlines and telemetry

`SUWAPPU_OPERATION_TIMEOUT_MS` defaults to 25,000ms and must be between 100 and 30,000ms. Reads can be retried by the loop policy; a managed execute timeout is never a proof of failure.

With `SUWAPPU_API_EVENTS=1`, stderr receives records such as:

```text
suwappu_api_event {"operation":"quote","outcome":"response_ok","duration_ms":184.2,"status":200}
```

Only operation, transport/protocol outcome, duration, and optional HTTP status are emitted. These events intentionally exclude secrets, wallet/market terms, quote/swap IDs, bodies, and error text. `response_ok` means a parseable HTTP response at that adapter boundary; it does not mean a swap is terminally successful.

Alert on sustained request failure/timeout rates, recurring rate limits, long-lived `submitting`/`outcome_unknown`, repeated simulation blocks, and reconciliation lag. Duplicate economic actions should have a target of zero.

## Call and cost budget

At interval `I` seconds, one continuously watched target performs up to approximately `86,400 / I` price reads per day before route qualification. At the default 30 seconds that is 2,880 reads/day/target.

Additional work occurs only as the workflow advances:

| State | Additional Suwappu calls |
|---|---|
| Price does not trigger | none |
| Preview candidate | quote |
| New managed candidate | quote + simulation + execute; status as needed |
| Known in-flight swap | status only before another economic action |
| Unknown outcome, no swap ID | fresh same-terms quote + simulation + same-key retry |

Use your current Suwappu pricing/credit contract when converting these calls to money. Set customer plan fences from measured usage and contribution margin; do not treat request volume itself as customer value.

## Incident order

When something looks wrong:

1. **Stop new authority**: remove the managed execution gate / stop the process and supervisor.
2. **Preserve evidence**: journal, lock, release SHA, safe logs/events; never copy secrets into tickets.
3. **Reconcile known IDs**: `bun src/cli.ts executions --reconcile` after acquiring a safe maintenance window.
4. **Classify ambiguity**: do not convert `outcome_unknown` into failed without evidence.
5. **Check wallet/server policy** and on-chain/managed status using the authoritative Suwappu workflow.
6. **Repair before restart**; resume with a small cap and bounded `--max-trades`.

Do not “fix” an incident by deleting the journal, minting new idempotency keys, or automatically clearing locks.

## Release gate

Before merging or deploying a money-path change:

```bash
bun install --frozen-lockfile
bun run verify
```

CI additionally builds the container and runs CodeQL. Review changes to `src/execution.ts`, `src/suwappu.ts`, live CLI gates, Docker commands, and state migrations as money-path changes. A release that alters retry/idempotency semantics needs explicit regression coverage for ambiguous outcomes.

## Scope and graduation

This product is deliberately not a replacement for a strategy framework. [Freqtrade](https://www.freqtrade.io/en/stable/backtesting/) is a useful benchmark when backtesting/dry-run, strategy bias analysis, and protection machinery are the problem. [Hummingbot Strategy V2](https://hummingbot.org/strategies/v2-strategies/) is a useful benchmark when controllers and finite order executors across venues are the problem.

Keep this repository focused on the Suwappu boundary: signal versus executable route, explicit authority, durable economic intent, simulation, idempotent managed submission, and truthful reconciliation.
