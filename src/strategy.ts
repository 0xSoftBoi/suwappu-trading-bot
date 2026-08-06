export function shouldBuy(price: number, target: number): boolean {
  return Number.isFinite(price) && price > 0 && Number.isFinite(target) && target > 0 && price < target;
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

  if (!options.execute) {
    return { kind: "preview" };
  }

  if (options.allowManagedExecution !== "1") {
    throw new Error(
      "Managed execution is locked. Set SUWAPPU_ALLOW_MANAGED_EXECUTION=1 as well as --execute.",
    );
  }

  if (!options.walletAddress) {
    throw new Error(
      "SUWAPPU_WALLET_ADDRESS is required for pre-execution swap simulation.",
    );
  }

  return { kind: "managed", walletAddress: options.walletAddress };
}
