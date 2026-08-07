export function shouldBuy(referencePrice: number, target: number): boolean {
  return Number.isFinite(referencePrice)
    && referencePrice > 0
    && Number.isFinite(target)
    && target > 0
    && referencePrice < target;
}

export function retryWait(interval: number, retries: number, maxWait = 120): number {
  return Math.min(maxWait, interval * retries);
}

export type ExecutionMode =
  | { kind: "preview" }
  | { kind: "managed"; walletAddress: string };

export function resolveExecutionMode(options: {
  execute: boolean;
  dryRun: boolean;
  allowManagedExecution?: string;
  walletAddress?: string;
}): ExecutionMode {
  if (options.execute && options.dryRun) {
    throw new Error("--execute and --dry-run cannot be used together");
  }
  if (!options.execute) return { kind: "preview" };
  if (options.allowManagedExecution !== "1") {
    throw new Error(
      "Managed execution is locked. Set SUWAPPU_ALLOW_MANAGED_EXECUTION=1 as well as --execute.",
    );
  }
  if (!options.walletAddress) {
    throw new Error("SUWAPPU_WALLET_ADDRESS is required for managed execution.");
  }
  return { kind: "managed", walletAddress: options.walletAddress };
}

export function requireUsdcTradeAmount(amountText: string, capText: string): number {
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("--amount must be a positive USDC amount");
  }
  const cap = Number(capText);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error("SUWAPPU_MAX_TRADE_USDC must be a positive number");
  }
  if (amount > cap) {
    throw new Error(
      `--amount ${amount} USDC exceeds SUWAPPU_MAX_TRADE_USDC=${cap}`,
    );
  }
  return amount;
}

export function conservativeAcquisitionPrice(args: {
  inputUsdc: number;
  minimumOutput: number;
  estimatedGasUsd: number;
}): number {
  if (!Number.isFinite(args.inputUsdc) || args.inputUsdc <= 0) {
    throw new Error("Input USDC must be positive");
  }
  if (!Number.isFinite(args.minimumOutput) || args.minimumOutput <= 0) {
    throw new Error("Quote minimum output must be positive");
  }
  if (!Number.isFinite(args.estimatedGasUsd) || args.estimatedGasUsd < 0) {
    throw new Error("Quote must include a non-negative estimated gas USD value");
  }
  return (args.inputUsdc + args.estimatedGasUsd) / args.minimumOutput;
}
