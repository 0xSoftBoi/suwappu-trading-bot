#!/usr/bin/env bun
import { Command } from "commander";
import { createClient } from "@suwappu/sdk";
import {
  executeManagedSwap,
  getPrice,
  simulateSwap,
} from "./suwappu.js";
import {
  resolveExecutionMode,
  retryWait,
  shouldBuy,
} from "./strategy.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      name === "SUWAPPU_API_KEY"
        ? `${name} is not set. Register an agent at https://api.suwappu.bot/v1/agent/register`
        : `${name} is not set`,
    );
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface BotOptions {
  chain: string;
  from: string;
  to: string;
  amount: string;
  target: number;
  interval: number;
  execute: boolean;
  dryRun: boolean;
  json: boolean;
  maxRetries: number;
  maxTrades: number;
}

function validateOptions(opts: BotOptions): void {
  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("--amount must be positive");
  if (!Number.isFinite(opts.target) || opts.target <= 0) throw new Error("--target must be positive");
  if (!Number.isInteger(opts.interval) || opts.interval < 10) {
    throw new Error("--interval must be at least 10 seconds");
  }
  if (!Number.isInteger(opts.maxRetries) || opts.maxRetries <= 0) {
    throw new Error("--max-retries must be a positive integer");
  }
  if (!Number.isInteger(opts.maxTrades) || opts.maxTrades <= 0) {
    throw new Error("--max-trades must be a positive integer");
  }
}

async function runBot(opts: BotOptions): Promise<void> {
  validateOptions(opts);

  const apiKey = requireEnv("SUWAPPU_API_KEY");
  const mode = resolveExecutionMode({
    execute: opts.execute,
    dryRun: opts.dryRun,
    allowManagedExecution: process.env.SUWAPPU_ALLOW_MANAGED_EXECUTION,
    walletAddress: process.env.SUWAPPU_WALLET_ADDRESS,
  });
  const client = createClient({ apiKey });

  await client.listChains();

  if (!opts.json) {
    console.log("Suwappu Trading Bot");
    console.log(`  Chain: ${opts.chain} | Buy: ${opts.amount} ${opts.from} → ${opts.to}`);
    console.log(`  Target: < $${opts.target} | Interval: ${opts.interval}s`);
    console.log(
      mode.kind === "managed"
        ? `  Mode: MANAGED EXECUTION (simulate first, max ${opts.maxTrades} trade${opts.maxTrades === 1 ? "" : "s"})`
        : "  Mode: PREVIEW (quotes only; no transaction submission)",
    );
    console.log();
  }

  let trades = 0;
  let retries = 0;

  const shutdown = () => {
    if (!opts.json) console.log(`\nStopped. ${trades} managed swaps submitted.`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (true) {
    try {
      const price = await getPrice(apiKey, opts.to, opts.chain);

      if (!shouldBuy(price, opts.target)) {
        if (opts.json) {
          console.log(
            JSON.stringify({
              token: opts.to,
              chain: opts.chain,
              price,
              target: opts.target,
              action: "wait",
            }),
          );
        } else {
          console.log(`${opts.to}: $${price.toFixed(2)} (target: < $${opts.target})`);
        }
        retries = 0;
        await sleep(opts.interval * 1000);
        continue;
      }

      const quote = await client.getQuote(
        opts.from,
        opts.to,
        Number(opts.amount),
        opts.chain,
      );
      if (!quote.id) throw new Error("Suwappu returned a quote without an id");

      if (mode.kind === "preview") {
        if (opts.json) {
          console.log(
            JSON.stringify({
              token: opts.to,
              chain: opts.chain,
              price,
              target: opts.target,
              action: "would_buy",
              quote: {
                id: quote.id,
                fromAmount: opts.amount,
                fromToken: opts.from,
                toAmount: quote.toAmount,
                toToken: opts.to,
                dex: quote.dex || "auto",
              },
            }),
          );
        } else {
          console.log(`${opts.to}: $${price.toFixed(2)} < $${opts.target} — WOULD BUY`);
          console.log(
            `  Quote: ${opts.amount} ${opts.from} → ${quote.toAmount} ${opts.to} (via ${quote.dex || "auto"})`,
          );
        }
      } else {
        const simulation = await simulateSwap(apiKey, quote.id, mode.walletAddress);
        if (simulation.success === false) {
          throw new Error(`Swap simulation failed: ${simulation.reason ?? "unknown reason"}`);
        }

        const swap = await executeManagedSwap(apiKey, quote.id);
        trades += 1;

        if (opts.json) {
          console.log(
            JSON.stringify({
              token: opts.to,
              chain: opts.chain,
              price,
              target: opts.target,
              action: "submitted",
              quoteId: quote.id,
              simulation: { success: simulation.success ?? true },
              swap,
            }),
          );
        } else {
          console.log(`${opts.to}: $${price.toFixed(2)} < $${opts.target} — EXECUTING`);
          console.log(
            `  Quote: ${opts.amount} ${opts.from} → ${quote.toAmount} ${opts.to} (via ${quote.dex || "auto"})`,
          );
          console.log("  Simulation: passed");
          console.log(
            `  Swap: ${swap.status} | ID: ${swap.swapId} | TX: ${swap.txHash ?? "pending"}`,
          );
        }

        if (trades >= opts.maxTrades) {
          if (!opts.json) {
            console.log(`Reached --max-trades ${opts.maxTrades}; stopping.`);
          }
          return;
        }
      }

      retries = 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      retries += 1;

      if (/429|rate/i.test(message)) {
        const wait = retryWait(opts.interval, retries);
        console.error(`Rate limited. Waiting ${wait}s... (${retries}/${opts.maxRetries})`);
        if (retries >= opts.maxRetries) throw new Error("Max retries reached");
        await sleep(wait * 1000);
        continue;
      }

      console.error(`Error: ${message}`);
      if (retries >= opts.maxRetries) throw new Error("Max retries reached");
    }

    await sleep(opts.interval * 1000);
  }
}

const program = new Command()
  .name("suwappu-trading-bot")
  .description("Preview-first price-target trading example using Suwappu")
  .version("1.0.0")
  .option("--chain <chain>", "chain to trade on", "base")
  .option("--from <token>", "source token", "USDC")
  .option("--to <token>", "token to buy", "ETH")
  .option("--amount <n>", "source-token amount per trade", "100")
  .option("--target <price>", "buy below this USD price", Number.parseFloat, 2000)
  .option("--interval <secs>", "poll interval in seconds", Number.parseInt, 30)
  .option("--execute", "enable managed-wallet swap submission", false)
  .option("--dry-run", "deprecated; preview is already the default", false)
  .option("--json", "write one JSON object per check to stdout", false)
  .option("--max-retries <n>", "max consecutive errors before exit", Number.parseInt, 5)
  .option("--max-trades <n>", "managed swaps before stopping", Number.parseInt, 1)
  .action((opts) => runBot(opts as BotOptions));

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
