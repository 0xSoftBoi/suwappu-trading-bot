import { afterEach, describe, expect, it } from "bun:test";
import {
  executeManagedSwap,
  getQuote,
  getReferencePrice,
  simulateSwap,
  SuwappuRequestError,
} from "../src/suwappu.js";
import {
  conservativeAcquisitionPrice,
  requireUsdcTradeAmount,
  resolveExecutionMode,
  retryWait,
  shouldBuy,
} from "../src/strategy.js";

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.SUWAPPU_API_URL;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.SUWAPPU_API_URL;
  else process.env.SUWAPPU_API_URL = originalApiUrl;
});

describe("reference trigger and route economics", () => {
  it("requests the chain-neutral price contract without inventing a chain parameter", async () => {
    process.env.SUWAPPU_API_URL = "https://example.test";
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return jsonResponse({ prices: { ETH: { usd: 1995.88 } } });
    }) as unknown as typeof fetch;

    expect(await getReferencePrice("key", "eth")).toBe(1995.88);
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/v1/agent/prices");
    expect(url.searchParams.get("symbols")).toBe("eth");
    expect(url.searchParams.has("chain")).toBe(false);
  });

  it("triggers only for a valid positive reference price below target", () => {
    expect(shouldBuy(1950, 2000)).toBe(true);
    expect(shouldBuy(2000, 2000)).toBe(false);
    expect(shouldBuy(Number.NaN, 2000)).toBe(false);
  });

  it("uses minimum output plus gas for the conservative route price", () => {
    expect(conservativeAcquisitionPrice({
      inputUsdc: 100,
      minimumOutput: 0.05,
      estimatedGasUsd: 2,
    })).toBe(2040);
  });

  it("enforces a positive USDC-denominated per-action cap", () => {
    expect(requireUsdcTradeAmount("100", "250")).toBe(100);
    expect(() => requireUsdcTradeAmount("251", "250")).toThrow("exceeds");
    expect(() => requireUsdcTradeAmount("100", "0")).toThrow("SUWAPPU_MAX_TRADE_USDC");
  });
});

describe("quote and simulation contracts", () => {
  it("accepts only internally consistent, expiring quotes", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: true,
      quote_id: "quote-1",
      amount_in: "100",
      amount_out: "0.052",
      amount_out_min: "0.05",
      estimated_gas_usd: "1.25",
      bridge_fee_usd: "0.30",
      dex: "router",
      expires_in_seconds: 60,
    })) as unknown as typeof fetch;

    const quote = await getQuote("key", {
      from: "USDC",
      to: "ETH",
      amount: "100",
      chain: "base",
      walletAddress: "0xabc",
    });
    expect(quote.id).toBe("quote-1");
    expect(quote.toAmountMin).toBe("0.05");
    expect(quote.estimatedGasUsd).toBe(1.25);
    expect(quote.reportedRouteFeeUsd).toBe(0.3);
    expect(quote.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("does not confuse API success with permission to execute", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: true,
      would_execute: false,
      warnings: ["insufficient gas"],
      checks: [{ name: "gas", status: "failed", detail: "fund wallet" }],
    })) as unknown as typeof fetch;

    const simulation = await simulateSwap("key", "quote-1", "0xabc");
    expect(simulation.wouldExecute).toBe(false);
    expect(simulation.warnings).toEqual(["insufficient gas"]);
  });
});

describe("managed execute contract", () => {
  it("sends the exact caller-owned idempotency key", async () => {
    let headerValue = "";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      headerValue = new Headers(init?.headers).get("Idempotency-Key") ?? "";
      return jsonResponse({ swap_id: "swap-1", status: "pending" });
    }) as unknown as typeof fetch;

    const result = await executeManagedSwap("key", "quote-1", {
      idempotencyKey: "tb.buy.intent-123",
    });
    expect(headerValue).toBe("tb.buy.intent-123");
    expect(result.swapId).toBe("swap-1");
  });

  it("classifies 5xx and network failures as outcome-unknown", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "upstream" }, 503)) as unknown as typeof fetch;
    try {
      await executeManagedSwap("key", "quote-1", { idempotencyKey: "intent.1" });
      throw new Error("expected executeManagedSwap to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SuwappuRequestError);
      expect((error as SuwappuRequestError).outcomeUnknown).toBe(true);
    }

    globalThis.fetch = (async () => {
      throw new TypeError("socket closed");
    }) as unknown as typeof fetch;
    try {
      await executeManagedSwap("key", "quote-2", { idempotencyKey: "intent.2" });
      throw new Error("expected executeManagedSwap to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SuwappuRequestError);
      expect((error as SuwappuRequestError).outcomeUnknown).toBe(true);
    }
  });
});

describe("managed execution gate and backoff", () => {
  it("defaults to preview and requires both independent live gates", () => {
    expect(resolveExecutionMode({
      execute: false,
      dryRun: false,
      allowManagedExecution: "1",
      walletAddress: "0xabc",
    })).toEqual({ kind: "preview" });

    expect(() => resolveExecutionMode({ execute: true, dryRun: false, walletAddress: "0xabc" }))
      .toThrow("SUWAPPU_ALLOW_MANAGED_EXECUTION=1");
    expect(() => resolveExecutionMode({ execute: true, dryRun: false, allowManagedExecution: "1" }))
      .toThrow("SUWAPPU_WALLET_ADDRESS");
  });

  it("backs off linearly and caps at 120 seconds", () => {
    expect(retryWait(30, 1)).toBe(30);
    expect(retryWait(30, 3)).toBe(90);
    expect(retryWait(30, 5)).toBe(120);
  });
});
