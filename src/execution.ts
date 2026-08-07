import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  executeManagedSwap,
  getManagedSwapStatus,
  isFailedSwapStatus,
  isSuccessfulSwapStatus,
  simulateSwap,
  SuwappuRequestError,
} from "./suwappu.js";

export type ExecutionPhase =
  | "prepared"
  | "submitting"
  | "submitted"
  | "completed"
  | "failed"
  | "outcome_unknown";

export interface EconomicTerms {
  fromToken: string;
  toToken: string;
  amount: string;
  chain: string;
}

export interface ExecutionIntent {
  id: string;
  strategy: string;
  actionKey: string;
  phase: ExecutionPhase;
  terms: EconomicTerms;
  context?: Record<string, string | number | boolean | null>;
  quoteId?: string;
  quotedToAmount?: string;
  quotedToAmountMin?: string;
  swapId?: string;
  swapStatus?: string;
  txHash?: string;
  actualFromAmount?: string;
  actualToAmount?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  accountedAt?: string;
}

export interface QuoteForExecution {
  id: string;
  toAmount: string;
  toAmountMin: string;
}

const EXECUTION_PHASES = new Set<ExecutionPhase>([
  "prepared",
  "submitting",
  "submitted",
  "completed",
  "failed",
  "outcome_unknown",
]);

function stateDir(): string {
  return (
    process.env.SUWAPPU_TRADING_BOT_STATE_DIR ??
    join(homedir(), ".suwappu-trading-bot")
  );
}

function journalFile(): string {
  return join(stateDir(), "execution-journal.json");
}

function lockFile(): string {
  return join(stateDir(), "execution.lock");
}

function ensureStateDir(): string {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function validContext(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)),
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function journalLimit(): number {
  const value = Number(process.env.SUWAPPU_TRADING_BOT_JOURNAL_LIMIT ?? "5000");
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(
      "SUWAPPU_TRADING_BOT_JOURNAL_LIMIT must be an integer between 1 and 100000",
    );
  }
  return value;
}

function applyJournalRetention(entries: ExecutionIntent[]): ExecutionIntent[] {
  const limit = journalLimit();
  let excess = entries.length - limit;
  if (excess <= 0) return entries;

  return entries.filter((intent) => {
    const safelyResolved =
      intent.phase === "failed" || intent.accountedAt !== undefined;
    if (excess > 0 && safelyResolved) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

function isExecutionIntent(value: unknown): value is ExecutionIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<ExecutionIntent>;
  const terms = intent.terms as Partial<EconomicTerms> | undefined;
  const amount = Number(terms?.amount);
  return (
    typeof intent.id === "string" &&
    intent.id.length > 0 &&
    typeof intent.strategy === "string" &&
    intent.strategy.length > 0 &&
    typeof intent.actionKey === "string" &&
    intent.actionKey.length > 0 &&
    typeof intent.phase === "string" &&
    EXECUTION_PHASES.has(intent.phase as ExecutionPhase) &&
    !!terms &&
    typeof terms.fromToken === "string" &&
    terms.fromToken.length > 0 &&
    typeof terms.toToken === "string" &&
    terms.toToken.length > 0 &&
    typeof terms.amount === "string" &&
    Number.isFinite(amount) &&
    amount > 0 &&
    typeof terms.chain === "string" &&
    terms.chain.length > 0 &&
    validContext(intent.context) &&
    typeof intent.createdAt === "string" &&
    typeof intent.updatedAt === "string" &&
    (intent.accountedAt === undefined ||
      typeof intent.accountedAt === "string") &&
    optionalString(intent.swapId) &&
    optionalString(intent.quoteId) &&
    optionalString(intent.quotedToAmount) &&
    optionalString(intent.quotedToAmountMin) &&
    optionalString(intent.swapStatus) &&
    optionalString(intent.txHash) &&
    optionalString(intent.actualFromAmount) &&
    optionalString(intent.actualToAmount) &&
    optionalString(intent.error)
  );
}

function loadJournal(): ExecutionIntent[] {
  if (!existsSync(journalFile())) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(journalFile(), "utf-8"));
  } catch (error) {
    throw new Error(
      `Execution journal is unreadable; refusing to create a new economic action: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isExecutionIntent)) {
    throw new Error(
      "Execution journal is invalid; refusing to create a new economic action",
    );
  }
  return parsed;
}

function saveJournal(entries: ExecutionIntent[]): void {
  const dir = ensureStateDir();
  const target = journalFile();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(
      fd,
      JSON.stringify(applyJournalRetention(entries), null, 2),
      "utf-8",
    );
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is not available on every platform/filesystem.
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export class ExecutionLockError extends Error {
  constructor(readonly path: string) {
    super(
      `Execution lock ${path} already exists; another money-moving owner may be active. Prove the owning process is gone before clearing a stale lock`,
    );
    this.name = "ExecutionLockError";
  }
}

/**
 * Acquire exclusive ownership of the local execution journal. The returned
 * release function verifies an ownership token before unlinking the path, so
 * it cannot accidentally remove a replacement lock.
 */
export function acquireExecutionLock(): () => void {
  ensureStateDir();
  const path = lockFile();
  const ownerToken = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ExecutionLockError(path);
    throw error;
  }

  try {
    writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        ownerToken,
      }),
      "utf-8",
    );
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    if (existsSync(path)) unlinkSync(path);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    if (!existsSync(path)) return;
    try {
      const current = JSON.parse(readFileSync(path, "utf-8")) as {
        ownerToken?: unknown;
      };
      if (current.ownerToken === ownerToken) unlinkSync(path);
    } catch {
      // Never delete a lock whose current ownership cannot be proven.
    }
  };
}

export async function withExecutionLock<T>(work: () => Promise<T>): Promise<T> {
  const release = acquireExecutionLock();
  try {
    return await work();
  } finally {
    release();
  }
}

function saveEntry(entry: ExecutionIntent): void {
  const entries = loadJournal();
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  entry.updatedAt = new Date().toISOString();
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  // Never prune unresolved idempotency keys. Losing one can turn recovery into
  // a second economic action.
  saveJournal(entries);
}

function sameTerms(a: EconomicTerms, b: EconomicTerms): boolean {
  return (
    a.fromToken.toUpperCase() === b.fromToken.toUpperCase() &&
    a.toToken.toUpperCase() === b.toToken.toUpperCase() &&
    a.chain.toLowerCase() === b.chain.toLowerCase() &&
    a.amount === b.amount
  );
}

function makeIntentId(): string {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `tb.buy.${Date.now().toString(36)}.${random}`.slice(0, 64);
}

function currentIntent(
  strategy: string,
  actionKey: string,
): ExecutionIntent | undefined {
  return loadJournal()
    .slice()
    .reverse()
    .find(
      (intent) =>
        intent.strategy === strategy &&
        intent.actionKey === actionKey &&
        !intent.accountedAt &&
        intent.phase !== "failed",
    );
}

export function getUnaccountedExecution(
  strategy: string,
): ExecutionIntent | undefined {
  return loadJournal()
    .slice()
    .reverse()
    .find(
      (intent) =>
        intent.strategy === strategy &&
        !intent.accountedAt &&
        intent.phase !== "failed",
    );
}

export function listExecutionJournal(limit = 25): ExecutionIntent[] {
  return loadJournal().slice(-Math.max(1, limit)).reverse();
}

export function markExecutionAccounted(intentId: string): void {
  const entries = loadJournal();
  const intent = entries.find((candidate) => candidate.id === intentId);
  if (!intent) return;
  intent.accountedAt = new Date().toISOString();
  intent.updatedAt = intent.accountedAt;
  saveJournal(entries);
}

export function abandonPreparedExecution(
  intentId: string,
  reason: string,
): void {
  const entries = loadJournal();
  const intent = entries.find((candidate) => candidate.id === intentId);
  if (!intent) return;
  if (intent.phase !== "prepared") {
    throw new Error(
      `Cannot abandon ${intent.phase} execution intent ${intentId}`,
    );
  }
  intent.phase = "failed";
  intent.error = reason;
  intent.updatedAt = new Date().toISOString();
  saveJournal(entries);
}

function applyStatus(
  intent: ExecutionIntent,
  status: Awaited<ReturnType<typeof getManagedSwapStatus>>,
): void {
  intent.swapId = status.swapId;
  intent.swapStatus = status.status;
  intent.txHash = status.txHash ?? intent.txHash;
  intent.actualFromAmount = status.fromAmount ?? intent.actualFromAmount;
  intent.actualToAmount = status.toAmount ?? intent.actualToAmount;
  intent.error = status.errorMessage ?? undefined;
  if (isSuccessfulSwapStatus(status.status)) intent.phase = "completed";
  else if (isFailedSwapStatus(status.status)) intent.phase = "failed";
  else intent.phase = "submitted";
}

async function reconcileKnownSwap(
  apiKey: string,
  intent: ExecutionIntent,
): Promise<ExecutionIntent> {
  if (!intent.swapId) return intent;
  try {
    const status = await getManagedSwapStatus(apiKey, intent.swapId);
    applyStatus(intent, status);
    saveEntry(intent);
  } catch (error) {
    intent.error = `Reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    saveEntry(intent);
  }
  return intent;
}

/** Poll known swap IDs only. Never creates a quote or submits an economic action. */
export async function reconcileExecutionJournal(
  apiKey: string,
): Promise<ExecutionIntent[]> {
  const entries = loadJournal();
  for (const intent of entries) {
    if (intent.accountedAt || !intent.swapId || intent.phase === "failed")
      continue;
    await reconcileKnownSwap(apiKey, intent);
  }
  return listExecutionJournal(entries.length || 1);
}

export async function runManagedExecution(args: {
  apiKey: string;
  strategy: string;
  actionKey: string;
  terms: EconomicTerms;
  walletAddress: string;
  getQuote: () => Promise<QuoteForExecution>;
  context?: Record<string, string | number | boolean | null>;
}): Promise<{ intent: ExecutionIntent }> {
  let intent = currentIntent(args.strategy, args.actionKey);

  if (intent && !sameTerms(intent.terms, args.terms)) {
    throw new Error(
      `Unreconciled ${args.strategy}/${args.actionKey} intent ${intent.id} has different economic terms`,
    );
  }
  if (intent?.phase === "completed") {
    if (intent.swapId && (!intent.actualFromAmount || !intent.actualToAmount)) {
      intent = await reconcileKnownSwap(args.apiKey, intent);
    }
    return { intent };
  }
  if (intent?.swapId) {
    intent = await reconcileKnownSwap(args.apiKey, intent);
    return { intent };
  }

  const isNew = !intent;
  if (!intent) {
    const now = new Date().toISOString();
    intent = {
      id: makeIntentId(),
      strategy: args.strategy,
      actionKey: args.actionKey,
      phase: "prepared",
      terms: args.terms,
      context: args.context,
      createdAt: now,
      updatedAt: now,
    };
    saveEntry(intent);
  }

  const hadSubmissionRisk =
    intent.phase === "submitting" || intent.phase === "outcome_unknown";
  let quote: QuoteForExecution;
  try {
    quote = await args.getQuote();
  } catch (error) {
    if (isNew) {
      intent.phase = "failed";
      intent.error = `Quote failed before submission: ${error instanceof Error ? error.message : String(error)}`;
      saveEntry(intent);
    }
    throw error;
  }

  intent.quoteId = quote.id;
  intent.quotedToAmount = quote.toAmount;
  intent.quotedToAmountMin = quote.toAmountMin;
  saveEntry(intent);

  const simulation = await simulateSwap(
    args.apiKey,
    quote.id,
    args.walletAddress,
  );
  if (!simulation.wouldExecute) {
    const warnings = simulation.warnings.length
      ? `: ${simulation.warnings.join("; ")}`
      : "";
    intent.phase = hadSubmissionRisk ? "outcome_unknown" : "failed";
    intent.error = hadSubmissionRisk
      ? `Retry simulation blocked while an earlier submission may have executed${warnings}`
      : `Simulation blocked execution${warnings}`;
    saveEntry(intent);
    return { intent };
  }

  // From this persisted state onward a crash is ambiguous. Every retry keeps
  // the same server-compatible intent ID / Idempotency-Key.
  intent.phase = "submitting";
  intent.error = undefined;
  saveEntry(intent);

  try {
    const swap = await executeManagedSwap(args.apiKey, quote.id, {
      idempotencyKey: intent.id,
    });
    intent.swapId = swap.swapId;
    intent.swapStatus = swap.status;
    intent.txHash = swap.txHash;
    intent.phase = isSuccessfulSwapStatus(swap.status)
      ? "completed"
      : isFailedSwapStatus(swap.status)
        ? "failed"
        : "submitted";
    saveEntry(intent);

    if (intent.swapId && intent.phase === "completed") {
      intent = await reconcileKnownSwap(args.apiKey, intent);
    }
  } catch (error) {
    intent.phase =
      error instanceof SuwappuRequestError && !error.outcomeUnknown
        ? "failed"
        : "outcome_unknown";
    intent.error = error instanceof Error ? error.message : String(error);
    saveEntry(intent);
  }

  return { intent };
}
