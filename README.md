# Suwappu Trading Bot

A small, outcome-safe reference for building a price-triggered product on top of [Suwappu](https://suwappu.bot).

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
| Report what really happened | Store terminal status and final amounts separately from quoted amounts |
| Keep a demo from becoming an unlimited bot | Preview default, two live gates, USDC cap, completed-trade limit |

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

Requires Bun 1.3.14 or newer.

```bash
git clone https://github.com/0xSoftBoi/suwappu-trading-bot.git
cd suwappu-trading-bot
bun install

curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-trading-bot"}'

export SUWAPPU_API_KEY=suwappu_sk_...

# Preview only. This can read prices and request quotes, but cannot submit.
bun src/cli.ts --chain base --from USDC --to ETH --amount 25 --target 2000
```

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

If the execute request times out, the connection drops after write, a 5xx is returned, or a successful response is malformed, the bot cannot prove that no transaction occurred. It records `outcome_unknown` and does **not** invent a fresh trade.

Recovery keeps the original economic terms and the same idempotency key. If a swap ID is already known, recovery only polls that swap; it does not resubmit.

Inspect the journal at any time:

```bash
bun src/cli.ts executions
bun src/cli.ts executions --reconcile
bun src/cli.ts executions --json
```

`--reconcile` polls known swap IDs only. It never creates a quote or submits a transaction.

The default journal is `~/.suwappu-trading-bot/execution-journal.json`; override it with `SUWAPPU_TRADING_BOT_STATE_DIR`. Do not delete unresolved journal entries as a retry mechanism. This reference assumes one bot process owns a state directory; add locking or transactional storage before running multiple workers.

## Python companion

`bot.py` is intentionally preview-only and uses only the Python standard library:

```bash
export SUWAPPU_API_KEY=suwappu_sk_...
python bot.py --to-token ETH --amount 25 --target 2000
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
| `SUWAPPU_API_URL` | No | API base URL override for development |

## Why a small REST adapter?

`src/suwappu.ts` is a typed adapter over the production contracts this example needs: prices, wallet-aware quote, simulation, managed execute, and status. It keeps this reference honest about the API surface it actually runs against instead of assuming a locally newer SDK has already been published everywhere.

The permission distinction matters for agent tooling: Suwappu's hosted MCP `execute_swap` flow prepares an unsigned/self-custody transaction; this bot's explicit `/swap/execute` path is managed execution. “Prepare for the caller to sign” and “submit from a managed wallet” should never share an implicit permission boundary.

## How this stacks up

This project should not try to become another full trading framework.

| Project | Best at | What it means for this repo |
|---|---|---|
| This repository | Minimal Suwappu signal → quote → simulate → idempotent managed-swap lifecycle | Copy the integration and outcome-safety patterns |
| [Freqtrade](https://www.freqtrade.io/en/stable/strategy-101/) | Strategy development with backtesting/dry-run; it also documents [stop-loss](https://www.freqtrade.io/en/stable/stoploss/) and [protections](https://www.freqtrade.io/en/stable/plugins/) | Use a deeper strategy framework when you need evidence about entries/exits and risk controls |
| [Hummingbot Strategy V2](https://hummingbot.org/strategies/v2-strategies/) | Controllers plus Executors that own finite order lifecycles | A useful model once one price-triggered action grows into orchestration across many orders/venues |

The value of this repository is its small Suwappu-specific boundary: it shows exactly where a signal stops and executable routing, permission, idempotency, and reconciliation begin.

## Docker

```bash
cp .env.example .env
# Leave SUWAPPU_ALLOW_MANAGED_EXECUTION=0 for preview.
docker compose up --build
```

Compose uses `restart: "no"`, so a one-shot live process is not silently started again after reaching its completed-trade limit. It also mounts a named volume at `/data` and stores the execution journal there. The default container command remains preview-only; entering live mode also requires intentionally adding `--execute` to the command.

## Develop

```bash
bun run check
bun test
python -m py_compile bot.py
python -m unittest discover -s tests -p 'test_*.py' -v
```

The regression suite covers the `would_execute` gate, exact idempotency-key reuse after ambiguous failures, known-swap reconciliation without resubmission, terminal final amounts, chain-neutral prices, quote validation, and client-side caps.

## Build further

- [Turn this reference into a product](BUILDING_A_PRODUCT.md)
- [Suwappu trading-bot guide](https://docs.suwappu.bot/guides/building-a-trading-bot)
- [Suwappu docs](https://docs.suwappu.bot)
- [Suwappu SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [Suwappu Python SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk-python)
- [API reference](https://api.suwappu.bot/v1/agent/openapi)

Use Suwappu's chain/token discovery surfaces instead of hard-coding a provider or chain count that will go stale.

## License

MIT
