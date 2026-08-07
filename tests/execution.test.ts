import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listExecutionJournal,
  runManagedExecution,
  type EconomicTerms,
} from "../src/execution.js";

const originalFetch = globalThis.fetch;
const originalStateDir = process.env.SUWAPPU_TRADING_BOT_STATE_DIR;
const originalApiUrl = process.env.SUWAPPU_API_URL;
const terms: EconomicTerms = {
  fromToken: "USDC",
  toToken: "ETH",
  amount: "100",
  chain: "base",
};
let stateDir = "";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quote(id = "quote-1") {
  return { id, toAmount: "0.052", toAmountMin: "0.05" };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "suwappu-trading-bot-test-"));
  process.env.SUWAPPU_TRADING_BOT_STATE_DIR = stateDir;
  process.env.SUWAPPU_API_URL = "https://example.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStateDir === undefined) delete process.env.SUWAPPU_TRADING_BOT_STATE_DIR;
  else process.env.SUWAPPU_TRADING_BOT_STATE_DIR = originalStateDir;
  if (originalApiUrl === undefined) delete process.env.SUWAPPU_API_URL;
  else process.env.SUWAPPU_API_URL = originalApiUrl;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("durable managed execution", () => {
  it("fails closed on an unreadable journal before quoting or submitting", async () => {
    writeFileSync(join(stateDir, "execution-journal.json"), "not-json");
    let quoteCalls = 0;

    await expect(runManagedExecution({
      apiKey: "key",
      strategy: "price-target",
      actionKey: "signal-1",
      terms,
      walletAddress: "0xabc",
      getQuote: async () => {
        quoteCalls += 1;
        return quote();
      },
    })).rejects.toThrow("Execution journal is unreadable");
    expect(quoteCalls).toBe(0);
  });

  it("never executes when simulation says would_execute=false", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      paths.push(new URL(String(input)).pathname);
      return jsonResponse({
        success: true,
        would_execute: false,
        warnings: ["balance check failed"],
      });
    }) as unknown as typeof fetch;

    const { intent } = await runManagedExecution({
      apiKey: "key",
      strategy: "price-target",
      actionKey: "signal-2",
      terms,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });

    expect(intent.phase).toBe("failed");
    expect(paths).toEqual(["/v1/agent/swap/simulate"]);
    expect(paths).not.toContain("/v1/agent/swap/execute");
  });

  it("retries an outcome-unknown submission with the same idempotency key", async () => {
    const executeKeys: string[] = [];
    let executeCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) {
        return jsonResponse({ success: true, would_execute: true, warnings: [], checks: [] });
      }
      if (path.endsWith("/swap/execute")) {
        executeCalls += 1;
        executeKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        if (executeCalls === 1) throw new TypeError("connection reset after write");
        return jsonResponse({ swap_id: "swap-1", status: "pending" });
      }
      throw new Error(`unexpected request ${path}`);
    }) as unknown as typeof fetch;

    const first = await runManagedExecution({
      apiKey: "key",
      strategy: "price-target",
      actionKey: "signal-3",
      terms,
      walletAddress: "0xabc",
      getQuote: async () => quote("quote-a"),
    });
    expect(first.intent.phase).toBe("outcome_unknown");

    const second = await runManagedExecution({
      apiKey: "key",
      strategy: "price-target",
      actionKey: "signal-3",
      terms,
      walletAddress: "0xabc",
      getQuote: async () => quote("quote-b"),
    });
    expect(second.intent.phase).toBe("submitted");
    expect(executeKeys).toHaveLength(2);
    expect(executeKeys[0]).toBe(executeKeys[1]);
    expect(executeKeys[0]).toBe(first.intent.id);
  });

  it("polls a known pending swap instead of submitting it again", async () => {
    let executeCalls = 0;
    let statusCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) {
        return jsonResponse({ success: true, would_execute: true });
      }
      if (path.endsWith("/swap/execute")) {
        executeCalls += 1;
        return jsonResponse({ swap_id: "swap-pending", status: "pending" });
      }
      if (path.endsWith("/swap/status/swap-pending")) {
        statusCalls += 1;
        return jsonResponse({ swap_id: "swap-pending", status: "pending" });
      }
      throw new Error(`unexpected request ${path}`);
    }) as unknown as typeof fetch;

    await runManagedExecution({
      apiKey: "key",
      strategy: "price-target",
      actionKey: "signal-4",
      terms,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });
    await runManagedExecution({
      apiKey: "key",
      strategy: "price-target",
      actionKey: "signal-4",
      terms,
      walletAddress: "0xabc",
      getQuote: async () => {
        throw new Error("a known swap must not request another quote");
      },
    });

    expect(executeCalls).toBe(1);
    expect(statusCalls).toBe(1);
  });

  it("records terminal final amounts separately from quoted amounts", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) {
        return jsonResponse({ success: true, would_execute: true });
      }
      if (path.endsWith("/swap/execute")) {
        return jsonResponse({ swap_id: "swap-done", status: "completed", tx_hash: "0x123" });
      }
      if (path.endsWith("/swap/status/swap-done")) {
        return jsonResponse({
          swap_id: "swap-done",
          status: "completed",
          tx_hash: "0x123",
          from_amount: "99.8",
          to_amount: "0.0491",
        });
      }
      throw new Error(`unexpected request ${path}`);
    }) as unknown as typeof fetch;

    const { intent } = await runManagedExecution({
      apiKey: "key",
      strategy: "price-target",
      actionKey: "signal-5",
      terms,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });

    expect(intent.phase).toBe("completed");
    expect(intent.quotedToAmount).toBe("0.052");
    expect(intent.actualFromAmount).toBe("99.8");
    expect(intent.actualToAmount).toBe("0.0491");
    const persisted = JSON.parse(readFileSync(join(stateDir, "execution-journal.json"), "utf8"));
    expect(persisted[0].actualToAmount).toBe("0.0491");
    expect(listExecutionJournal()[0].swapId).toBe("swap-done");
  });
});
