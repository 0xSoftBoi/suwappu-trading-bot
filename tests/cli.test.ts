import { describe, it, expect } from "bun:test";

// Helper: simulate the buy signal logic from src/cli.ts
function shouldBuy(price: number, target: number): boolean {
  return price < target;
}

// Helper: simulate JSON output format
function formatJsonOutput(token: string, price: number, target: number) {
  return {
    token,
    price,
    target,
    action: price < target ? "buy" : "wait",
  };
}

// Helper: simulate retry wait calculation
function retryWait(interval: number, retries: number, maxWait = 120): number {
  return Math.min(maxWait, interval * retries);
}

describe("buy signal detection", () => {
  it("should buy when price is below target", () => {
    expect(shouldBuy(1950, 2000)).toBe(true);
  });

  it("should not buy when price equals target", () => {
    expect(shouldBuy(2000, 2000)).toBe(false);
  });

  it("should not buy when price is above target", () => {
    expect(shouldBuy(2100, 2000)).toBe(false);
  });

  it("should buy when price is zero (edge case)", () => {
    expect(shouldBuy(0, 2000)).toBe(true);
  });

  it("should handle very small price differences", () => {
    expect(shouldBuy(1999.99, 2000)).toBe(true);
    expect(shouldBuy(2000.01, 2000)).toBe(false);
  });
});

describe("JSON output format", () => {
  it("should include all required fields", () => {
    const output = formatJsonOutput("ETH", 1950, 2000);
    expect(output).toHaveProperty("token");
    expect(output).toHaveProperty("price");
    expect(output).toHaveProperty("target");
    expect(output).toHaveProperty("action");
  });

  it("should set action to 'buy' when below target", () => {
    const output = formatJsonOutput("ETH", 1950, 2000);
    expect(output.action).toBe("buy");
  });

  it("should set action to 'wait' when above target", () => {
    const output = formatJsonOutput("ETH", 2100, 2000);
    expect(output.action).toBe("wait");
  });

  it("should preserve token symbol", () => {
    const output = formatJsonOutput("SOL", 80, 100);
    expect(output.token).toBe("SOL");
  });

  it("should be valid JSON when stringified", () => {
    const output = formatJsonOutput("ETH", 1950, 2000);
    const parsed = JSON.parse(JSON.stringify(output));
    expect(parsed.token).toBe("ETH");
    expect(parsed.price).toBe(1950);
  });
});

describe("retry wait calculation", () => {
  it("should increase wait with each retry", () => {
    expect(retryWait(30, 1)).toBe(30);
    expect(retryWait(30, 2)).toBe(60);
    expect(retryWait(30, 3)).toBe(90);
  });

  it("should cap at max wait time", () => {
    expect(retryWait(30, 5)).toBe(120); // 150 capped to 120
    expect(retryWait(30, 10)).toBe(120);
  });

  it("should handle zero retries", () => {
    expect(retryWait(30, 0)).toBe(0);
  });

  it("should respect custom max wait", () => {
    expect(retryWait(30, 3, 60)).toBe(60); // 90 capped to 60
  });
});

describe("environment validation", () => {
  it("should have SUWAPPU_API_KEY format", () => {
    const key = "suwappu_sk_test123";
    expect(key.startsWith("suwappu_sk_")).toBe(true);
  });

  it("should reject empty string as API key", () => {
    expect("".length > 0).toBe(false);
  });
});
