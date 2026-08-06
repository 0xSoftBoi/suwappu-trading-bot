# Suwappu Trading Bot

A preview-first price-target trading example for builders using [Suwappu](https://suwappu.bot).

It shows the full managed-wallet safety path: read a real price, obtain a wallet-aware quote, simulate that exact quote, then submit it only after two independent execution opt-ins.

> This is an integration example, not financial advice. Use a dedicated wallet, restrictive Suwappu wallet policies, and small amounts while developing.

## Safe by default

| Mode | How to enter it | Network behavior |
|---|---|---|
| Preview | default | prices + quotes only |
| Managed execution | `--execute` **and** `SUWAPPU_ALLOW_MANAGED_EXECUTION=1` | quote → simulate → managed submit |
| Self-custody | not implemented by this bot | use Suwappu's unsigned transaction flow instead |

Live mode also requires `SUWAPPU_WALLET_ADDRESS`. The address is included when the quote is created and is used again for simulation.

A successful simulation is required before `POST /v1/agent/swap/execute` can be called. Managed mode stops after one submitted swap by default; increasing `--max-trades` is an explicit choice.

## TypeScript quick start

Requires Bun.

```bash
git clone https://github.com/0xSoftBoi/suwappu-trading-bot.git
cd suwappu-trading-bot
bun install

curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-trading-bot"}'

export SUWAPPU_API_KEY=suwappu_sk_...

# Preview only: no transaction can be submitted.
bun src/cli.ts --chain base --from USDC --to ETH --amount 25 --target 2000
```

`--amount` is an amount of the **source token**, not a USD amount. `--amount 25 --from USDC` is 25 USDC; `--amount 25 --from ETH` is 25 ETH.

## Enabling managed execution

First configure the intended managed wallet and use Suwappu wallet policies to put server-side limits around it. Then opt in at both the environment and command line:

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

When the target is met, the bot:

1. fetches a current chain-specific USD price;
2. creates a fresh quote bound to `SUWAPPU_WALLET_ADDRESS`;
3. calls `/v1/agent/swap/simulate`;
4. refuses to continue unless the simulation explicitly returns `success: true`;
5. submits the quote through the managed-wallet `/v1/agent/swap/execute` endpoint;
6. stops when `--max-trades` submitted swaps have been reached.

A missing, zero, negative, or malformed price is an error—never a buy signal.

## Python version

The Python example follows the same current REST contract and safety gates.

```bash
python -m pip install requests
export SUWAPPU_API_KEY=suwappu_sk_...

# Preview
python bot.py --to-token ETH --amount 25 --target 2000

# Managed execution uses the same two extra environment variables.
python bot.py --to-token ETH --amount 25 --target 2000 --execute
```

The Suwappu Python SDK source is newer than the published package surface and is not currently distributed on PyPI, so this small Python example intentionally uses the REST API directly.

## Options

| Flag | Default | Meaning |
|---|---:|---|
| `--chain` | `base` | Chain to trade on |
| `--from` / `--from-token` | `USDC` | Source token |
| `--to` / `--to-token` | `ETH` | Token to buy |
| `--amount` | `100` | Source-token amount per trade |
| `--target` | `2000` | Buy only below this USD price |
| `--interval` | `30` | Price polling interval in seconds (minimum 10) |
| `--execute` | off | Opt into managed execution |
| `--max-trades` | `1` | Stop after this many managed swap submissions |
| `--max-retries` | `5` | Stop after this many consecutive errors |
| `--json` | off | Emit one JSON object per check on stdout |
| `--dry-run` | — | Deprecated compatibility flag; preview is already default |

## Why this example uses a small REST bridge

The currently published npm package is `@suwappu/sdk@0.4.0`. The Suwappu repository already contains a newer 0.6 TypeScript SDK surface with current prices, wallet-aware quotes, simulation, swap status/history, wallet policies, and the corrected split between managed and self-custody execution.

This repository does not pretend that unpublished source is on npm. `src/suwappu.ts` is a small typed adapter over today's production endpoints. Once the newer SDK is published, its intended managed flow is the same:

```text
getQuote({ ..., walletAddress })
  → simulateSwap({ quoteId, walletAddress })
  → swap(quote)                  # managed execution
```

For self-custody, use `prepareSwap({ quoteId, walletAddress })` in the newer SDK source; it returns an unsigned transaction for the caller to sign. The hosted MCP endpoint (`https://api.suwappu.bot/mcp`) also exposes an `execute_swap` tool whose result is unsigned/self-custody—it is not the managed execution endpoint used by this bot.

That distinction is important when you build agent tooling: “prepare an unsigned transaction” and “submit a managed-wallet transaction” should never share an implicit permission boundary.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `SUWAPPU_API_KEY` | Yes | Authenticates the agent |
| `SUWAPPU_WALLET_ADDRESS` | Live mode | Wallet bound to the quote and simulation |
| `SUWAPPU_ALLOW_MANAGED_EXECUTION` | Live mode | Must equal `1` in addition to `--execute` |
| `SUWAPPU_API_URL` | No | Override the API base URL for development |

## JSON mode

Stdout stays machine-readable:

```json
{"token":"ETH","chain":"base","price":1995.88,"target":2000,"action":"would_buy","quote":{"id":"quote_...","fromAmount":"25","fromToken":"USDC","toAmount":"0.0125","toToken":"ETH","dex":"auto"}}
```

Operational errors go to stderr.

## Docker

```bash
cp .env.example .env
# Keep SUWAPPU_ALLOW_MANAGED_EXECUTION=0 for preview mode.
docker compose up --build
```

The default container command is preview-only. Do not set the managed execution opt-in until you also intentionally change the container command to include `--execute`.

## Develop

```bash
bun run check
bun test
python -m py_compile bot.py
```

Regression tests specifically cover the zero-price failure case and the managed-execution gate.

## Build further

- [Suwappu docs](https://docs.suwappu.bot)
- [Trading bot guide](https://docs.suwappu.bot/guides/building-a-trading-bot)
- [Suwappu SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [Python SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk-python)
- [API reference](https://api.suwappu.bot/v1/agent/openapi)

Suwappu currently supports 14 chains; use the chain/token discovery APIs rather than hard-coding a provider count.

## License

MIT
