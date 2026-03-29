# suwappu-trading-bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://python.org)

Automated trading bot that monitors token prices and executes swaps when targets are hit. Uses the [Suwappu](https://suwappu.bot) cross-chain DEX API with 15+ chains and 9 swap providers.

> **Warning**: This bot executes real trades on real blockchains. Use test wallets and small amounts until you're confident in your configuration. This is not financial advice.

## Prerequisites

- [Bun](https://bun.sh) or Node.js 18+ (TypeScript version)
- Python 3.10+ (Python version)
- Suwappu API key ([get one free](https://api.suwappu.bot/v1/agent/register))
- Funded wallet with tokens to trade

## Install

```bash
git clone https://github.com/0xSoftBoi/suwappu-trading-bot.git
cd suwappu-trading-bot
bun install  # or npm install
```

## Usage

### TypeScript

```bash
export SUWAPPU_API_KEY=suwappu_sk_...

# Basic: buy ETH when it drops below $2000
bun run src/cli.ts

# Custom target and chain
bun run src/cli.ts --to SOL --target 80 --chain solana --amount 50

# Dry run (quote only, no execution)
bun run src/cli.ts --dry-run

# JSON output for piping
bun run src/cli.ts --json | jq '.price'
```

### Python

```bash
pip install requests
export SUWAPPU_API_KEY=suwappu_sk_...

python bot.py
python bot.py --to-token SOL --target 80 --chain solana --dry-run
python bot.py --json
```

### Docker

```bash
cp .env.example .env  # Edit with your API key
docker compose up -d
docker compose logs -f
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--chain` | `base` | Blockchain to trade on |
| `--from` | `USDC` | Token to spend |
| `--to` | `ETH` | Token to buy |
| `--amount` | `100` | Amount per trade |
| `--target` | `2000` | Buy when price drops below this |
| `--interval` | `30` | Poll interval (seconds) |
| `--dry-run` | off | Quote only, don't execute |
| `--json` | off | JSON output (one line per check) |
| `--max-retries` | `5` | Max consecutive errors before exit |

## How It Works

1. Validates API key and tests connection
2. Polls token prices at configured interval
3. When price drops below target, fetches a swap quote
4. Executes swap via Suwappu's managed wallet system
5. Handles rate limits with exponential backoff
6. Graceful shutdown on Ctrl+C with trade count summary

## Get an API Key

```bash
curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-trading-bot"}'
```

## Development

```bash
bun install
bun test          # Run tests
bun run check     # Type check
bun run dev       # Watch mode
```

## Links

- [Suwappu API Docs](https://docs.suwappu.bot)
- [Trading Bot Guide](https://docs.suwappu.bot/guides/building-a-trading-bot)
- [@suwappu/sdk](https://npmjs.com/package/@suwappu/sdk)
- [API Reference](https://api.suwappu.bot/v1/agent/openapi)

## License

MIT
