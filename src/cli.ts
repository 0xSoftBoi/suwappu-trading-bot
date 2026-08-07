#!/usr/bin/env bun
import { Command } from "commander";
import {
  acquireExecutionLock,
  abandonPreparedExecution,
  getUnaccountedExecution,
  listExecutionJournal,
  markExecutionAccounted,
  reconcileExecutionJournal,
  runManagedExecution,
  withExecutionLock,
  type EconomicTerms,
  type ExecutionIntent,
} from "./execution.js";
import {
  conservativeAcquisitionPrice,
  requireUsdcTradeAmount,
  resolveExecutionMode,
  retryWait,
  shouldBuy,
} from "./strategy.js";
import {
  getQuote,
  getReferencePrice,
  SuwappuRequestError,
  type CurrentQuote,
} from "./suwappu.js";

const STRATEGY = "price-target";
const DEFAULT_MAX_TRADE_USDC = "1000";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value !== value.trim()) {
    throw new Error(
      name === "SUWAPPU_API_KEY"
        ? `${name} is missing/invalid. Register an agent at https://api.suwappu.bot/v1/agent/register`
        : `${name} is missing/invalid`,
    );
  }
  return value;
}

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
  once: boolean;
}

class QuoteGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteGuardError";
  }
}

function validateOptions(opts: BotOptions): number {
  if (opts.from.trim().toUpperCase() !== "USDC") {
    throw new Error(
      "This price-target reference currently requires --from USDC",
    );
  }
  if (!opts.to.trim() || opts.to.trim().toUpperCase() === "USDC") {
    throw new Error("--to must be a non-USDC token symbol");
  }
  if (!opts.chain.trim()) throw new Error("--chain must not be empty");
  if (!Number.isFinite(opts.target) || opts.target <= 0)
    throw new Error("--target must be positive");
  if (!Number.isInteger(opts.interval) || opts.interval < 10) {
    throw new Error("--interval must be at least 10 seconds");
  }
  if (!Number.isInteger(opts.maxRetries) || opts.maxRetries <= 0) {
    throw new Error("--max-retries must be a positive integer");
  }
  if (!Number.isInteger(opts.maxTrades) || opts.maxTrades <= 0) {
    throw new Error("--max-trades must be a positive integer");
  }
  if (opts.once && opts.execute) {
    throw new Error(
      "--once is preview-only; use --max-trades to bound managed execution",
    );
  }
  return requireUsdcTradeAmount(
    opts.amount,
    process.env.SUWAPPU_MAX_TRADE_USDC ?? DEFAULT_MAX_TRADE_USDC,
  );
}

function makeActionKey(): string {
  return `signal.${Date.now().toString(36)}.${crypto.randomUUID().slice(0, 8)}`;
}

function targetFromIntent(intent: ExecutionIntent, fallback: number): number {
  const stored = intent.context?.targetUsd;
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0
    ? stored
    : fallback;
}

function quoteEconomics(
  quote: CurrentQuote,
  inputUsdc: number,
  targetUsd: number,
) {
  if (quote.estimatedGasUsd === null) {
    throw new QuoteGuardError(
      "Quote is missing estimated_gas_usd; refusing managed price-target execution",
    );
  }
  if (quote.expiresAtMs <= Date.now() + 5_000) {
    throw new QuoteGuardError(
      "Quote has 5 seconds or less remaining; request a fresh route",
    );
  }
  const minimumOutput = Number(quote.toAmountMin);
  const maxAcquisitionPriceUsd = conservativeAcquisitionPrice({
    inputUsdc,
    minimumOutput,
    estimatedGasUsd: quote.estimatedGasUsd,
  });
  if (maxAcquisitionPriceUsd >= targetUsd) {
    throw new QuoteGuardError(
      `Conservative quote price $${maxAcquisitionPriceUsd.toFixed(2)} is not below target $${targetUsd.toFixed(2)}`,
    );
  }
  return { minimumOutput, maxAcquisitionPriceUsd };
}

async function qualifiedQuote(args: {
  apiKey: string;
  terms: EconomicTerms;
  targetUsd: number;
  walletAddress?: string;
}): Promise<{ quote: CurrentQuote; maxAcquisitionPriceUsd: number }> {
  const quote = await getQuote(args.apiKey, {
    from: args.terms.fromToken,
    to: args.terms.toToken,
    amount: args.terms.amount,
    chain: args.terms.chain,
    walletAddress: args.walletAddress,
  });
  const inputUsdc = Number(args.terms.amount);
  const economics = quoteEconomics(quote, inputUsdc, args.targetUsd);
  return { quote, maxAcquisitionPriceUsd: economics.maxAcquisitionPriceUsd };
}

function jsonIntent(intent: ExecutionIntent) {
  return {
    intentId: intent.id,
    phase: intent.phase,
    swapId: intent.swapId ?? null,
    status: intent.swapStatus ?? null,
    txHash: intent.txHash ?? null,
    quotedToAmount: intent.quotedToAmount ?? null,
    actualFromAmount: intent.actualFromAmount ?? null,
    actualToAmount: intent.actualToAmount ?? null,
    error: intent.error ?? null,
  };
}

function printIntent(intent: ExecutionIntent, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify({ action: "execution_state", ...jsonIntent(intent) }),
    );
    return;
  }
  console.log(
    `Execution ${intent.id}: ${intent.phase}` +
      `${intent.swapId ? ` | swap ${intent.swapId}` : ""}` +
      `${intent.txHash ? ` | ${intent.txHash}` : ""}`,
  );
  if (intent.phase === "completed") {
    console.log(
      `  Final: ${intent.actualFromAmount ?? "?"} ${intent.terms.fromToken}` +
        ` → ${intent.actualToAmount ?? "?"} ${intent.terms.toToken}`,
    );
  }
  if (intent.error) console.log(`  Note: ${intent.error}`);
}

async function runBot(opts: BotOptions): Promise<void> {
  const amountUsdc = validateOptions(opts);
  const apiKey = requireEnv("SUWAPPU_API_KEY");
  const mode = resolveExecutionMode({
    execute: opts.execute,
    dryRun: opts.dryRun,
    allowManagedExecution: process.env.SUWAPPU_ALLOW_MANAGED_EXECUTION,
    walletAddress: process.env.SUWAPPU_WALLET_ADDRESS,
  });
  const releaseExecutionLock =
    mode.kind === "managed" ? acquireExecutionLock() : undefined;

  try {
    if (!opts.json) {
      console.log("Suwappu Price-Target Trading Bot");
      console.log(
        `  Chain: ${opts.chain} | Buy: ${amountUsdc} USDC → ${opts.to}`,
      );
      console.log(
        `  Reference trigger + conservative route target: < $${opts.target}`,
      );
      console.log(
        `  Interval: ${opts.interval}s | Per-action cap: ${process.env.SUWAPPU_MAX_TRADE_USDC ?? DEFAULT_MAX_TRADE_USDC} USDC`,
      );
      console.log(
        mode.kind === "managed"
          ? `  Mode: MANAGED (durable intent + simulate + idempotent submit + reconcile; max ${opts.maxTrades} completed)`
          : "  Mode: PREVIEW (reference price + quote only; no transaction submission)",
      );
      console.log();
    }

    let completedTrades = 0;
    let retries = 0;
    const shutdown = () => {
      if (!opts.json)
        console.log(
          `\nStopped. ${completedTrades} managed swaps reached terminal success this run.`,
        );
      releaseExecutionLock?.();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    while (true) {
      try {
        if (mode.kind === "managed") {
          const active = getUnaccountedExecution(STRATEGY);
          if (active) {
            const originalTarget = targetFromIntent(active, opts.target);
            try {
              const resumed = await runManagedExecution({
                apiKey,
                strategy: STRATEGY,
                actionKey: active.actionKey,
                terms: active.terms,
                walletAddress: mode.walletAddress,
                context: active.context,
                getQuote: async () =>
                  (
                    await qualifiedQuote({
                      apiKey,
                      terms: active.terms,
                      targetUsd: originalTarget,
                      walletAddress: mode.walletAddress,
                    })
                  ).quote,
              });
              printIntent(resumed.intent, opts.json);
              if (resumed.intent.phase === "completed") {
                markExecutionAccounted(resumed.intent.id);
                completedTrades += 1;
                retries = 0;
                if (completedTrades >= opts.maxTrades) return;
              }
            } catch (error) {
              if (
                error instanceof QuoteGuardError &&
                active.phase === "prepared"
              ) {
                abandonPreparedExecution(active.id, error.message);
                if (!opts.json)
                  console.log(
                    `Prepared intent ${active.id} abandoned safely: ${error.message}`,
                  );
              } else {
                throw error;
              }
            }
            await sleep(opts.interval * 1_000);
            continue;
          }
        }

        const referencePrice = await getReferencePrice(apiKey, opts.to);
        if (!shouldBuy(referencePrice, opts.target)) {
          if (opts.json) {
            console.log(
              JSON.stringify({
                token: opts.to,
                referencePriceUsd: referencePrice,
                targetUsd: opts.target,
                action: "wait",
                referenceFeed: "chain-neutral",
              }),
            );
          } else {
            console.log(
              `${opts.to} reference: $${referencePrice.toFixed(2)} (target: < $${opts.target})`,
            );
          }
          retries = 0;
          if (opts.once) return;
          await sleep(opts.interval * 1_000);
          continue;
        }

        const terms: EconomicTerms = {
          fromToken: "USDC",
          toToken: opts.to.toUpperCase(),
          amount: String(amountUsdc),
          chain: opts.chain.toLowerCase(),
        };
        let qualified;
        try {
          qualified = await qualifiedQuote({
            apiKey,
            terms,
            targetUsd: opts.target,
            walletAddress:
              mode.kind === "managed" ? mode.walletAddress : undefined,
          });
        } catch (error) {
          if (error instanceof QuoteGuardError) {
            if (opts.json) {
              console.log(
                JSON.stringify({
                  token: opts.to,
                  referencePriceUsd: referencePrice,
                  targetUsd: opts.target,
                  action: "quote_blocked",
                  reason: error.message,
                }),
              );
            } else {
              console.log(
                `${opts.to} reference: $${referencePrice.toFixed(2)} < $${opts.target} — ROUTE BLOCKED`,
              );
              console.log(`  ${error.message}`);
            }
            retries = 0;
            if (opts.once) return;
            await sleep(opts.interval * 1_000);
            continue;
          }
          throw error;
        }

        if (mode.kind === "preview") {
          if (opts.json) {
            console.log(
              JSON.stringify({
                token: opts.to,
                chain: terms.chain,
                referencePriceUsd: referencePrice,
                targetUsd: opts.target,
                action: "would_buy",
                conservativeRoutePriceUsd: qualified.maxAcquisitionPriceUsd,
                quote: {
                  id: qualified.quote.id,
                  fromAmount: qualified.quote.fromAmount,
                  fromToken: "USDC",
                  toAmount: qualified.quote.toAmount,
                  toAmountMin: qualified.quote.toAmountMin,
                  estimatedGasUsd: qualified.quote.estimatedGasUsd,
                  dex: qualified.quote.dex || "auto",
                },
              }),
            );
          } else {
            console.log(
              `${opts.to} reference: $${referencePrice.toFixed(2)} < $${opts.target} — WOULD BUY`,
            );
            console.log(
              `  Conservative route: $${qualified.maxAcquisitionPriceUsd.toFixed(2)}/${opts.to}` +
                ` | ${qualified.quote.fromAmount} USDC → min ${qualified.quote.toAmountMin} ${opts.to}`,
            );
          }
        } else {
          const actionKey = makeActionKey();
          const result = await runManagedExecution({
            apiKey,
            strategy: STRATEGY,
            actionKey,
            terms,
            walletAddress: mode.walletAddress,
            context: {
              targetUsd: opts.target,
              referencePriceUsd: referencePrice,
              conservativeRoutePriceUsd: qualified.maxAcquisitionPriceUsd,
            },
            getQuote: async () => qualified.quote,
          });
          printIntent(result.intent, opts.json);
          if (result.intent.phase === "completed") {
            markExecutionAccounted(result.intent.id);
            completedTrades += 1;
            if (completedTrades >= opts.maxTrades) return;
          }
        }

        retries = 0;
      } catch (error: unknown) {
        if (opts.once) throw error;
        const message = error instanceof Error ? error.message : String(error);
        retries += 1;
        const rateLimited =
          error instanceof SuwappuRequestError
            ? error.httpStatus === 429
            : /429|rate/i.test(message);
        if (rateLimited) {
          const wait = retryWait(opts.interval, retries);
          console.error(
            `Rate limited. Waiting ${wait}s... (${retries}/${opts.maxRetries})`,
          );
          if (retries >= opts.maxRetries)
            throw new Error("Max retries reached");
          await sleep(wait * 1_000);
          continue;
        }
        console.error(`Error: ${message}`);
        if (retries >= opts.maxRetries) throw new Error("Max retries reached");
      }

      if (opts.once) return;
      await sleep(opts.interval * 1_000);
    }
  } finally {
    releaseExecutionLock?.();
  }
}

async function showExecutions(options: {
  reconcile?: boolean;
  json?: boolean;
}): Promise<void> {
  const entries = options.reconcile
    ? await withExecutionLock(() =>
        reconcileExecutionJournal(requireEnv("SUWAPPU_API_KEY")),
      )
    : listExecutionJournal();
  if (options.json) {
    console.log(JSON.stringify(entries.map(jsonIntent)));
    return;
  }
  if (entries.length === 0) {
    console.log("No execution intents recorded.");
    return;
  }
  for (const intent of entries) printIntent(intent, false);
}

const program = new Command()
  .name("suwappu-trading-bot")
  .description("Standalone preview-first price-target workflow using Suwappu")
  .version("2.0.0")
  .option("--chain <chain>", "chain to trade on", "base")
  .option("--from <token>", "source token (currently USDC only)", "USDC")
  .option("--to <token>", "token to buy", "ETH")
  .option("--amount <n>", "USDC amount per economic action", "100")
  .option(
    "--target <price>",
    "buy only below this conservative USD/unit price",
    Number.parseFloat,
    2000,
  )
  .option("--interval <secs>", "poll interval in seconds", Number.parseInt, 30)
  .option("--execute", "enable managed-wallet submission", false)
  .option("--dry-run", "deprecated; preview is already the default", false)
  .option("--json", "write machine-readable JSON lines", false)
  .option("--once", "run one preview evaluation and exit", false)
  .option(
    "--max-retries <n>",
    "max consecutive errors before exit",
    Number.parseInt,
    5,
  )
  .option(
    "--max-trades <n>",
    "terminal-success swaps this run before stopping",
    Number.parseInt,
    1,
  )
  .action((opts) => runBot(opts as BotOptions));

program
  .command("executions")
  .description("Inspect the durable managed-execution journal")
  .option("--reconcile", "poll known swap IDs; never submit", false)
  .option("--json", "emit one JSON array", false)
  .action(showExecutions);

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
