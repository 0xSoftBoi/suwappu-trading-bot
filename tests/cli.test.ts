import { describe, expect, it } from "bun:test";
import { parseUsdPrice } from "../src/suwappu.js";
import {
  resolveExecutionMode,
  retryWait,
  shouldBuy,
} from "../src/strategy.js";

describe("buy signal detection", () => {
  it("triggers only for a valid positive price below target", () => {
    expect(shouldBuy(1950, 2000)).toBe(true);
    expect(shouldBuy(2000, 2000)).toBe(false);
    expect(shouldBuy(2100, 2000)).toBe(false);
  });

  it("never interprets a missing/zero price as a buy signal", () => {
    expect(shouldBuy(0, 2000)).toBe(false);
    expect(shouldBuy(Number.NaN, 2000)).toBe(false);
  });
});

describe("current Suwappu price response", () => {
  it("parses the requested symbol case-insensitively", () => {
    expect(parseUsdPrice({ prices: { ETH: { usd: "1995.88" } } }, "eth")).toBe(1995.88);
  });

  it("rejects missing and non-positive prices", () => {
    expect(() => parseUsdPrice({ prices: {} }, "ETH")).toThrow("No valid USD price");
    expect(() => parseUsdPrice({ prices: { ETH: { usd: 0 } } }, "ETH")).toThrow(
      "No valid USD price",
    );
  });
});

describe("managed execution gate", () => {
  it("defaults to preview even when credentials happen to exist", () => {
    expect(
      resolveExecutionMode({
        execute: false,
        dryRun: false,
        allowManagedExecution: "1",
        walletAddress: "0xabc",
      }),
    ).toEqual({ kind: "preview" });
  });

  it("requires an independent environment opt-in", () => {
    expect(() =>
      resolveExecutionMode({
        execute: true,
        dryRun: false,
        walletAddress: "0xabc",
      }),
    ).toThrow("SUWAPPU_ALLOW_MANAGED_EXECUTION=1");
  });

  it("requires a wallet address so live routes can be simulated first", () => {
    expect(() =>
      resolveExecutionMode({
        execute: true,
        dryRun: false,
        allowManagedExecution: "1",
      }),
    ).toThrow("SUWAPPU_WALLET_ADDRESS");
  });

  it("enables managed mode only when both gates are present", () => {
    expect(
      resolveExecutionMode({
        execute: true,
        dryRun: false,
        allowManagedExecution: "1",
        walletAddress: "0xabc",
      }),
    ).toEqual({ kind: "managed", walletAddress: "0xabc" });
  });

  it("rejects conflicting execute and legacy dry-run flags", () => {
    expect(() =>
      resolveExecutionMode({
        execute: true,
        dryRun: true,
        allowManagedExecution: "1",
        walletAddress: "0xabc",
      }),
    ).toThrow("--execute and --dry-run");
  });
});

describe("retry wait calculation", () => {
  it("backs off linearly and caps at 120 seconds", () => {
    expect(retryWait(30, 1)).toBe(30);
    expect(retryWait(30, 3)).toBe(90);
    expect(retryWait(30, 5)).toBe(120);
  });
});
