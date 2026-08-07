# Suwappu Trading Bot

A standalone, preview-first price-target workflow for building on [Suwappu](https://suwappu.bot). Version 2 keeps the deliberately narrow strategy while hardening the operating boundary around real money.

This repository deliberately solves one narrow problem well: use a cheap reference-price signal, qualify it with a real wallet-aware route, and—only after explicit opt-in—submit a managed swap with durable idempotency and reconcile the final outcome.

> This is an integration reference, not a profitable-strategy claim or financial advice. It does not include backtesting, exits, stop-loss logic, position sizing, portfolio risk, or alpha research.

## What you can learn here

| Builder problem | Pattern in this repo |
|---|---|
| Poll cheaply without pretending a price feed is executable liquidity | Chain-neutral `/prices` is a trigger only |
| Decide whether a route actually meets the target | Wallet-aware `/quote`, minimum output, estimated gas, quote TTL |
| Prevent an HTTP success from becoming accidental permission | Require `would_execute === true` from `/swap/simulate` |
| Survive a timeout after a money-moving request | Persist intent before submit and reuse one `Idempotency-Key` |
| Avoid duplicate recovery trades | Reconcile known swap IDs before creating a new economic action |
| Prevent two local workers from moving money concurrently | Exclusive process lock around the managed state machine and reconciliation |
| Report what really happened | Store terminal status and final amounts separately from quoted amounts |
| Keep a service from becoming an accidental spend loop | One-shot package/container default, preview default, two live gates, USDC cap, completed-trade limit |
| Operate it without leaking upstream bodies | Bounded API deadlines plus opt-in metadata-only events |

If you are building a product rather than a demo, continue with [BUILDING_A_PRODUCT.md](BUILDING_A_PRODUCT.md).

## Safe by default

| Mode | Enter it | Can submit a transaction? |
|---|---|---:|
| TypeScript preview | default | No |
| Python preview | default | No |
| Managed TypeScript | `--execute` **and** `SUWAPPU_ALLOW_MANAGED_EXECUTION=1` | Yes |
| Self-custody | not implemented here | No; use Suwappu's unsigned transaction flow |

Managed mode additionally requires `SUWAPPU_WALLET_ADDRESS`. Use a dedicated wallet and restrictive server-side wallet policies while developing.

## TypeScript quick start

Requires Bun 1.3.14 or newer. The repository includes `bun.lock`; use the frozen lockfile in CI/deployments.

```bash
git clone https://github.com/0xSoftBoi/suwappu-trading-bot.git
cd suwappu-trading-bot
bun install --frozen-lockfile

curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-trading-bot"}'

export SUWAPPU_API_KEY=suwappu_sk_...

# One preview evaluation. This can read prices/request a quote but cannot submit.
bun src/cli.ts --once --chain base --from USDC --to ETH --amount 25 --target 2000
```

`bun run start` is also one-shot and preview-only. Continuous monitoring is an explicit `bun run watch`; managed execution is a separate permission boundary described below.

This reference intentionally uses **USDC as the source token**. That makes the target and client-side cap explicit USD accounting instead of pretending an arbitrary source-token amount is dollars.

`SUWAPPU_MAX_TRADE_USDC` defaults to `1000`. A larger `--amount`, a missing/invalid cap, malformed price data, missing gas estimate, stale quote, or route price at/above the target fails closed.

## Two prices, two jobs

The most important implementation detail is that `/v1/agent/prices` is a **chain-neutral reference feed**. Passing a chain name does not turn it into executable on-chain liquidity.

The bot therefore uses two stages:

1. `GET /prices?symbols=ETH` cheaply decides whether ETH is worth examining.
2. `POST /quote` asks for the actual chain route and amount. The bot promotes the signal only when the conservative acquisition price is below the target:

```text
(input USDC + estimated gas USD) / minimum quoted output
```

The routed platform/route fee is already reflected in routed output; it is retained for attribution rather than subtracted a second time. `amount_out_min`, not optimistic `amount_out`, is the denominator.

## Managed execution

First configure the intended managed wallet and its server-side policies. Then add both independent live gates:

```bash
export SUWAPPU_WALLET_ADDRESS=0x...
export SUWAPPU_ALLOW_MANAGED_EXECUTION=1

bun src/cli.ts \
  --chain base \
  --from USDC \
  --to ETH \
  --amount 25 \
  --target 2000 \
  --execute \
  --max-trades 1
```

For each new economic action, the live path:

1. qualifies a fresh wallet-aware quote against the target;
2. writes a durable intent before submission risk begins;
3. calls `/swap/simulate` and requires **`would_execute: true`**;
4. persists `submitting` before the network request;
5. sends the durable intent ID as `Idempotency-Key` to `/swap/execute`;
6. records the swap ID when known and polls `/swap/status/:id` on later loops;
7. counts `--max-trades` only when swaps reach terminal success, using final amounts when available.

An HTTP 2xx simulation response is not an execution signal by itself. `success: true, would_execute: false` still blocks the swap.

### Timeouts are outcome-unknown

If the execute request times out, the connection drops after write, returns HTTP 408/5xx, or returns a malformed 2xx response, the bot cannot prove that no transaction occurred. It records `outcome_unknown` and does **not** invent a fresh trade.

Recovery keeps the original economic terms and the same idempotency key. If a swap ID is already known, recovery only polls that swap; it does not resubmit.

Inspect the journal at any time:

```bash
bun src/cli.ts executions
bun src/cli.ts executions --reconcile
bun src/cli.ts executions --json
```

`--reconcile` polls known swap IDs only. It never creates a quote or submits a transaction.

The default journal is `~/.suwappu-trading-bot/execution-journal.json`; override it with `SUWAPPU_TRADING_BOT_STATE_DIR`. Managed mode and `executions --reconcile` take an exclusive `execution.lock`, so one local state directory has one money-moving/reconciling owner. State is written with an atomic rename, file `0600` / directory `0700` permissions, and file `fsync`; malformed state fails closed. Retention only removes already-resolved records and never deletes unresolved idempotency state.

Do not delete an unresolved journal or lock to “fix” a retry. A lock left by a dead process requires an operator to prove that process is gone before removal; see [the operations runbook](docs/OPERATIONS.md). For multiple hosts/replicas, replace the JSON/lock boundary with transactional storage and distributed serialization.

## Python companion

`bot.py` is intentionally preview-only and uses only the Python standard library:

```bash
export SUWAPPU_API_KEY=suwappu_sk_...
python bot.py --once --to-token ETH --amount 25 --target 2000
```

It demonstrates the same chain-neutral reference trigger, strict quote parsing, minimum-output + gas guard, TTL check, and USDC cap. `python bot.py --execute` fails closed and points to the TypeScript managed implementation. Keeping one authoritative money-moving state machine is safer than maintaining two subtly different copies.

## Options

| TypeScript flag | Default | Meaning |
|---|---:|---|
| `--chain` | `base` | Chain used for the executable quote |
| `--from` | `USDC` | Source accounting token; only USDC is accepted here |
| `--to` | `ETH` | Token to acquire |
| `--amount` | `100` | USDC per economic action |
| `--target` | `2000` | Maximum conservative USD acquisition price per output token |
| `--interval` | `30` | Poll interval in seconds; minimum 10 |
| `--once` | off | Perform one preview evaluation and exit; cannot be combined with `--execute` |
| `--execute` | off | Opt into managed execution; still requires the environment gate |
| `--max-trades` | `1` | Terminal-success swaps this process may account before stopping |
| `--max-retries` | `5` | Consecutive loop errors before exit |
| `--json` | off | Emit machine-readable JSON lines |
| `--dry-run` | — | Deprecated compatibility flag; preview is already the default |

Important environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `SUWAPPU_API_KEY` | Yes | Agent authentication |
| `SUWAPPU_WALLET_ADDRESS` | Managed only | Binds the route and simulation to the intended wallet |
| `SUWAPPU_ALLOW_MANAGED_EXECUTION` | Managed only | Must equal `1`, in addition to `--execute` |
| `SUWAPPU_MAX_TRADE_USDC` | No | Per-action client cap; default `1000` |
| `SUWAPPU_TRADING_BOT_STATE_DIR` | No | Durable execution-journal directory |
| `SUWAPPU_TRADING_BOT_JOURNAL_LIMIT` | No | Soft resolved-record retention target; default `5000`, unresolved records are never pruned |
| `SUWAPPU_OPERATION_TIMEOUT_MS` | No | Per-operation deadline, 100–30000ms; default `25000` |
| `SUWAPPU_API_EVENTS` | No | `1`/`true` enables metadata-only API timing/outcome events on stderr |
| `SUWAPPU_API_URL` | No | API base URL override for development |

API events deliberately omit credentials, wallet/market terms, quote/swap IDs, bodies, and error text. They are transport/protocol telemetry—not proof that a managed swap reached a terminal on-chain state.

## Why a small REST adapter?

`src/suwappu.ts` is a typed adapter over the production contracts this example needs: prices, wallet-aware quote, simulation, managed execute, and status. It keeps this reference honest about the API surface it actually runs against instead of assuming a locally newer SDK has already been published everywhere.

The permission distinction matters for agent tooling: Suwappu's hosted MCP `execute_swap` flow prepares an unsigned/self-custody transaction; this bot's explicit `/swap/execute` path is managed execution. “Prepare for the caller to sign” and “submit from a managed wallet” should never share an implicit permission boundary.

## How this stacks up

This project should not try to become another full trading framework.

| Project | Best at | What it means for this repo |
|---|---|---|
| This repository | Minimal Suwappu signal → quote → simulate → idempotent managed-swap lifecycle | Copy the integration and outcome-safety patterns |
| [Freqtrade](https://www.freqtrade.io/en/stable/backtesting/) | A full bot stack with backtesting/dry-run and documented [protections](https://www.freqtrade.io/en/stable/plugins/) / [lookahead analysis](https://www.freqtrade.io/en/stable/lookahead-analysis/) | Graduate when the hard problem is strategy evidence, entries/exits, and portfolio risk |
| [Hummingbot Strategy V2](https://hummingbot.org/strategies/v2-strategies/) | A trading framework where [Executors](https://hummingbot.org/strategies/v2-strategies/executors/) own finite order lifecycles | Graduate when one Suwappu economic action becomes multi-order/venue orchestration |

The value of this repository is its small Suwappu-specific boundary: it shows exactly where a signal stops and executable routing, permission, idempotency, and reconciliation begin. It does **not** claim feature parity with those frameworks or strategy profitability.

## Docker

```bash
cp .env.example .env
# Leave SUWAPPU_ALLOW_MANAGED_EXECUTION=0 for preview.
docker compose up --build
```

The image runs non-root, mounts durable `/data`, and defaults to exactly one JSON preview evaluation. Compose uses `restart: "no"`, so a money-moving one-shot command cannot be silently restarted. Continuous preview and managed execution require an explicit command override; live mode still requires both `--execute` and `SUWAPPU_ALLOW_MANAGED_EXECUTION=1`.

## Develop

```bash
bun run verify
```

The regression suite covers the `would_execute` gate, exact idempotency-key reuse after ambiguous failures, known-swap reconciliation without resubmission, terminal final amounts, chain-neutral prices, quote binding, local locking/permissions, and client-side caps. CI additionally enforces the frozen dependency graph, standalone build, dependency audit, container build, and CodeQL analysis.

## Build further

- [Turn this reference into a product](BUILDING_A_PRODUCT.md)
- [Operate the standalone product](docs/OPERATIONS.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Suwappu trading-bot guide](https://docs.suwappu.bot/guides/building-a-trading-bot)
- [Suwappu docs](https://docs.suwappu.bot)
- [Suwappu SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [Suwappu Python SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk-python)
- [API reference](https://api.suwappu.bot/v1/agent/openapi)

Use Suwappu's chain/token discovery surfaces instead of hard-coding a provider or chain count that will go stale.

## License

MIT
