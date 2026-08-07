import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  return process.env.SUWAPPU_TRADING_BOT_STATE_DIR
    ?? join(homedir(), ".suwappu-trading-bot");
}

function journalFile(): string {
  return join(stateDir(), "execution-journal.json");
}

function isExecutionIntent(value: unknown): value is ExecutionIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<ExecutionIntent>;
  const terms = intent.terms as Partial<EconomicTerms> | undefined;
  return typeof intent.id === "string"
    && typeof intent.strategy === "string"
    && typeof intent.actionKey === "string"
    && typeof intent.phase === "string"
    && EXECUTION_PHASES.has(intent.phase as ExecutionPhase)
    && !!terms
    && typeof terms.fromToken === "string"
    && typeof terms.toToken === "string"
    && typeof terms.amount === "string"
    && typeof terms.chain === "string"
    && typeof intent.createdAt === "string"
    && typeof intent.updatedAt === "string"
    && (intent.accountedAt === undefined || typeof intent.accountedAt === "string")
    && (intent.swapId === undefined || typeof intent.swapId === "string")
    && (intent.quoteId === undefined || typeof intent.quoteId === "string");
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
    throw new Error("Execution journal is invalid; refusing to create a new economic action");
  }
  return parsed;
}

function saveJournal(entries: ExecutionIntent[]): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = journalFile();
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries, null, 2));
  renameSync(temporary, target);
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
  return a.fromToken.toUpperCase() === b.fromToken.toUpperCase()
    && a.toToken.toUpperCase() === b.toToken.toUpperCase()
    && a.chain.toLowerCase() === b.chain.toLowerCase()
    && a.amount === b.amount;
}

function makeIntentId(): string {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `tb.buy.${Date.now().toString(36)}.${random}`.slice(0, 64);
}

function currentIntent(strategy: string, actionKey: string): ExecutionIntent | undefined {
  return loadJournal().slice().reverse().find((intent) => (
    intent.strategy === strategy
    && intent.actionKey === actionKey
    && !intent.accountedAt
    && intent.phase !== "failed"
  ));
}

export function getUnaccountedExecution(strategy: string): ExecutionIntent | undefined {
  return loadJournal().slice().reverse().find((intent) => (
    intent.strategy === strategy && !intent.accountedAt && intent.phase !== "failed"
  ));
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

export function abandonPreparedExecution(intentId: string, reason: string): void {
  const entries = loadJournal();
  const intent = entries.find((candidate) => candidate.id === intentId);
  if (!intent) return;
  if (intent.phase !== "prepared") {
    throw new Error(`Cannot abandon ${intent.phase} execution intent ${intentId}`);
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

async function reconcileKnownSwap(apiKey: string, intent: ExecutionIntent): Promise<ExecutionIntent> {
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
export async function reconcileExecutionJournal(apiKey: string): Promise<ExecutionIntent[]> {
  const entries = loadJournal();
  for (const intent of entries) {
    if (intent.accountedAt || !intent.swapId || intent.phase === "failed") continue;
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

  const hadSubmissionRisk = intent.phase === "submitting" || intent.phase === "outcome_unknown";
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

  const simulation = await simulateSwap(args.apiKey, quote.id, args.walletAddress);
  if (!simulation.wouldExecute) {
    const warnings = simulation.warnings.length ? `: ${simulation.warnings.join("; ")}` : "";
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
    intent.phase = error instanceof SuwappuRequestError && !error.outcomeUnknown
      ? "failed"
      : "outcome_unknown";
    intent.error = error instanceof Error ? error.message : String(error);
    saveEntry(intent);
  }

  return { intent };
}
