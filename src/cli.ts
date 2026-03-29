#!/usr/bin/env bun
import { Command } from "commander";
import { createClient } from "@suwappu/sdk";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: ${name} not set`);
    if (name === "SUWAPPU_API_KEY") {
      console.error('  Get one: curl -X POST https://api.suwappu.bot/v1/agent/register -H "Content-Type: application/json" -d \'{"name":"my-bot"}\'');
    }
    process.exit(1);
  }
  return val;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BotOptions {
  chain: string;
  from: string;
  to: string;
  amount: string;
  target: number;
  interval: number;
  dryRun: boolean;
  json: boolean;
  maxRetries: number;
}

async function runBot(opts: BotOptions) {
  const apiKey = requireEnv("SUWAPPU_API_KEY");
  const client = createClient({ apiKey });

  // Validate connection
  try {
    await client.listChains();
  } catch (e: any) {
    console.error(`Connection failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`Suwappu Trading Bot`);
  console.log(`  Chain: ${opts.chain} | Buy: ${opts.amount} ${opts.from} → ${opts.to}`);
  console.log(`  Target: < $${opts.target} | Interval: ${opts.interval}s`);
  if (opts.dryRun) console.log(`  Mode: DRY RUN (quotes only, no execution)`);
  console.log();

  let trades = 0;
  let retries = 0;

  // Graceful shutdown
  process.on("SIGINT", () => { console.log(`\nStopped. ${trades} trades executed.`); process.exit(0); });
  process.on("SIGTERM", () => { console.log(`\nStopped. ${trades} trades executed.`); process.exit(0); });

  while (true) {
    try {
      const prices = await client.getPrices(opts.to);
      const price = parseFloat(prices[0]?.priceUsd ?? "0");

      if (opts.json) {
        console.log(JSON.stringify({ token: opts.to, price, target: opts.target, action: price < opts.target ? "buy" : "wait" }));
      } else if (price < opts.target) {
        console.log(`${opts.to}: $${price.toFixed(2)} < $${opts.target} — ${opts.dryRun ? "WOULD BUY" : "BUYING"}!`);
        
        const quote = await client.getQuote(opts.from, opts.to, parseFloat(opts.amount), opts.chain);
        console.log(`  Quote: ${opts.amount} ${opts.from} → ${quote.toAmount} ${opts.to} (via ${quote.dex || "auto"})`);

        if (!opts.dryRun) {
          const result = await client.executeSwap(quote.id);
          console.log(`  Swap: ${result.status} | TX: ${result.txHash || "pending"}`);
          trades++;
        }
      } else {
        console.log(`${opts.to}: $${price.toFixed(2)} (target: < $${opts.target})`);
      }
      retries = 0;
    } catch (e: any) {
      if (e.message?.includes("429") || e.message?.includes("rate")) {
        retries++;
        const wait = Math.min(120, opts.interval * retries);
        console.error(`Rate limited. Waiting ${wait}s... (${retries}/${opts.maxRetries})`);
        await sleep(wait * 1000);
        if (retries >= opts.maxRetries) { console.error("Max retries. Exiting."); process.exit(1); }
        continue;
      }
      console.error(`Error: ${e.message}`);
      if (++retries >= opts.maxRetries) { console.error("Max retries. Exiting."); process.exit(1); }
    }
    await sleep(opts.interval * 1000);
  }
}

const program = new Command()
  .name("suwappu-trading-bot")
  .description("Automated price-target trading bot using Suwappu cross-chain DEX")
  .version("1.0.0")
  .option("--chain <chain>", "chain to trade on", "base")
  .option("--from <token>", "token to spend", "USDC")
  .option("--to <token>", "token to buy", "ETH")
  .option("--amount <n>", "amount per trade", "100")
  .option("--target <price>", "buy below this price", parseFloat, 2000)
  .option("--interval <secs>", "poll interval in seconds", parseInt, 30)
  .option("--dry-run", "quote only, don't execute swaps", false)
  .option("--json", "output as JSON (one line per check)", false)
  .option("--max-retries <n>", "max consecutive errors before exit", parseInt, 5)
  .action((opts) => runBot(opts as BotOptions));

program.parseAsync();
