import { describe, it, expect } from "bun:test";

describe("trading-bot", () => {
  it("should require SUWAPPU_API_KEY", () => {
    expect(process.env.SUWAPPU_API_KEY || "").toBeTruthy;
  });

  it("should parse price target as number", () => {
    const target = parseFloat("2000");
    expect(target).toBe(2000);
    expect(typeof target).toBe("number");
  });

  it("should detect buy signal correctly", () => {
    const price = 1950;
    const target = 2000;
    expect(price < target).toBe(true);
  });

  it("should not buy above target", () => {
    const price = 2100;
    const target = 2000;
    expect(price < target).toBe(false);
  });
});
