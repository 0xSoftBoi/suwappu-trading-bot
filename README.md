# suwappu-trading-bot

Automated trading bot that monitors token prices and buys on dip. Uses [Suwappu](https://suwappu.bot) cross-chain DEX.

## Quick Start

```bash
# TypeScript
npm install && export SUWAPPU_API_KEY=suwappu_sk_... && npx tsx bot.ts

# Python
pip install requests && export SUWAPPU_API_KEY=suwappu_sk_... && python bot.py
```

## Get an API Key

```bash
curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" -d '{"name":"my-bot"}'
```

## Config

| Variable | Default | Description |
|----------|---------|-------------|
| CHAIN | base | Chain to trade on |
| PRICE_TARGET | 2000 | Buy below this |
| BUY_AMOUNT | 100 | USDC per trade |
| POLL_INTERVAL | 30s | Check frequency |

## Links

- [Docs](https://docs.suwappu.bot) | [Guide](https://docs.suwappu.bot/guides/building-a-trading-bot)
