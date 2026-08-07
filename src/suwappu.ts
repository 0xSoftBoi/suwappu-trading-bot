const DEFAULT_API_BASE_URL = "https://api.suwappu.bot";
const REQUEST_TIMEOUT_MS = 30_000;

function apiBaseUrl(): string {
  return (process.env.SUWAPPU_API_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
}

export interface CurrentQuote {
  id: string;
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  estimatedGasUsd: number | null;
  reportedRouteFeeUsd: number | null;
  dex: string;
  expiresAtMs: number;
}

export interface SwapSimulation {
  wouldExecute: boolean;
  warnings: string[];
  checks: Array<{ name: string; status: string; detail: string }>;
}

export interface ManagedSwapResult {
  swapId: string;
  status: string;
  txHash?: string;
  pollUrl?: string;
}

export interface ManagedSwapStatus {
  swapId: string;
  status: string;
  txHash?: string;
  fromAmount?: string;
  toAmount?: string;
  errorMessage?: string;
}

export class SuwappuRequestError extends Error {
  readonly httpStatus?: number;
  readonly outcomeUnknown: boolean;

  constructor(message: string, options: { httpStatus?: number; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = "SuwappuRequestError";
    this.httpStatus = options.httpStatus;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  throw new Error("Malformed JSON response from Suwappu");
}

function parsePositive(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Malformed Suwappu response: ${field} must be positive`);
  }
  return number;
}

function parseUsd(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[$,]/g, "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function request<T extends Record<string, unknown>>(
  apiKey: string,
  method: string,
  path: string,
  options: { params?: Record<string, string | undefined>; json?: unknown } = {},
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) search.set(key, value);
  }
  const query = search.toString();

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
    });
  } catch (error) {
    throw new SuwappuRequestError(error instanceof Error ? error.message : String(error));
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text || response.statusText;
    try {
      const parsed = parseJson(text);
      detail = String(parsed.error ?? parsed.message ?? detail);
    } catch {}
    throw new SuwappuRequestError(`Suwappu API error ${response.status}: ${detail}`, {
      httpStatus: response.status,
    });
  }

  return parseJson(text) as T;
}

export function parseUsdPrice(
  payload: { prices?: Record<string, { usd?: string | number }> },
  symbol: string,
): number {
  const entry = Object.entries(payload.prices ?? {}).find(
    ([key]) => key.toUpperCase() === symbol.toUpperCase(),
  );
  const price = Number(entry?.[1]?.usd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`No valid USD reference price returned for ${symbol}`);
  }
  return price;
}

/** Chain-neutral CoinGecko-backed reference price. Never treat this as route liquidity. */
export async function getReferencePrice(apiKey: string, symbol: string): Promise<number> {
  const payload = await request<{ prices?: Record<string, { usd?: string | number }> }>(
    apiKey,
    "GET",
    "/v1/agent/prices",
    { params: { symbols: symbol } },
  );
  return parseUsdPrice(payload, symbol);
}

export async function getQuote(
  apiKey: string,
  args: {
    from: string;
    to: string;
    amount: string;
    chain: string;
    walletAddress?: string;
  },
): Promise<CurrentQuote> {
  const payload = await request<{
    success?: boolean;
    quote_id?: string;
    amount_in?: string | number;
    amount_out?: string | number;
    amount_out_min?: string | number;
    estimated_gas_usd?: string | number;
    bridge_fee_usd?: string | number;
    dex?: string;
    expires_in_seconds?: number;
  }>(apiKey, "POST", "/v1/agent/quote", {
    json: {
      from_token: args.from,
      to_token: args.to,
      amount: args.amount,
      chain: args.chain,
      ...(args.walletAddress ? { wallet_address: args.walletAddress } : {}),
    },
  });

  if (payload.success !== true || !payload.quote_id) {
    throw new Error("Malformed quote response: missing success/quote_id");
  }
  const amountIn = parsePositive(payload.amount_in, "amount_in");
  const amountOut = parsePositive(payload.amount_out, "amount_out");
  const amountOutMin = parsePositive(payload.amount_out_min, "amount_out_min");
  if (amountOutMin > amountOut) {
    throw new Error("Malformed quote response: amount_out_min exceeds amount_out");
  }
  const requestedAmount = parsePositive(args.amount, "requested amount");
  if (Math.abs(amountIn - requestedAmount) > Math.max(1e-9, requestedAmount * 1e-9)) {
    throw new Error("Malformed quote response: amount_in did not match request");
  }
  const expiresInSeconds = parsePositive(payload.expires_in_seconds, "expires_in_seconds");

  return {
    id: payload.quote_id,
    fromAmount: String(payload.amount_in),
    toAmount: String(payload.amount_out),
    toAmountMin: String(payload.amount_out_min),
    estimatedGasUsd: parseUsd(payload.estimated_gas_usd),
    reportedRouteFeeUsd: parseUsd(payload.bridge_fee_usd),
    dex: String(payload.dex ?? ""),
    expiresAtMs: Date.now() + expiresInSeconds * 1_000,
  };
}

export async function simulateSwap(
  apiKey: string,
  quoteId: string,
  walletAddress: string,
): Promise<SwapSimulation> {
  const payload = await request<{
    would_execute?: boolean;
    warnings?: unknown[];
    checks?: Array<{ name?: unknown; status?: unknown; detail?: unknown }>;
  }>(apiKey, "POST", "/v1/agent/swap/simulate", {
    json: { quote_id: quoteId, wallet_address: walletAddress },
  });

  return {
    wouldExecute: payload.would_execute === true,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
    checks: Array.isArray(payload.checks)
      ? payload.checks.map((check) => ({
          name: String(check.name ?? ""),
          status: String(check.status ?? ""),
          detail: String(check.detail ?? ""),
        }))
      : [],
  };
}

export async function executeManagedSwap(
  apiKey: string,
  quoteId: string,
  { idempotencyKey }: { idempotencyKey: string },
): Promise<ManagedSwapResult> {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(idempotencyKey)) {
    throw new Error("Idempotency key must be 1-64 characters using A-Z, a-z, 0-9, _, ., :, or -");
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/v1/agent/swap/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ quote_id: quoteId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SuwappuRequestError(error instanceof Error ? error.message : String(error), {
      outcomeUnknown: true,
    });
  }

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = parseJson(text);
  } catch {
    if (response.ok) {
      throw new SuwappuRequestError("Malformed managed swap response", { outcomeUnknown: true });
    }
  }

  if (!response.ok) {
    throw new SuwappuRequestError(
      String(payload.error ?? payload.message ?? `Suwappu API error ${response.status}`),
      { httpStatus: response.status, outcomeUnknown: response.status >= 500 },
    );
  }

  if (payload.swap_id === undefined || typeof payload.status !== "string") {
    throw new SuwappuRequestError("Malformed managed swap response", { outcomeUnknown: true });
  }

  const tracking = payload.tracking as { poll_url?: unknown } | undefined;
  return {
    swapId: String(payload.swap_id),
    status: payload.status,
    ...(typeof payload.tx_hash === "string" && payload.tx_hash ? { txHash: payload.tx_hash } : {}),
    ...(typeof tracking?.poll_url === "string" ? { pollUrl: tracking.poll_url } : {}),
  };
}

export function isSuccessfulSwapStatus(status: string): boolean {
  return ["completed", "confirmed"].includes(status.toLowerCase());
}

export function isFailedSwapStatus(status: string): boolean {
  return status.toLowerCase() === "failed";
}

export async function getManagedSwapStatus(apiKey: string, swapId: string): Promise<ManagedSwapStatus> {
  const payload = await request<{
    swap_id?: string | number;
    status?: string;
    tx_hash?: string | null;
    from_amount?: string;
    to_amount?: string | null;
    error_message?: string | null;
  }>(apiKey, "GET", `/v1/agent/swap/status/${encodeURIComponent(swapId)}`);

  if (payload.swap_id === undefined || typeof payload.status !== "string") {
    throw new Error("Malformed managed swap status response");
  }

  return {
    swapId: String(payload.swap_id),
    status: payload.status,
    ...(payload.tx_hash ? { txHash: payload.tx_hash } : {}),
    ...(payload.from_amount ? { fromAmount: payload.from_amount } : {}),
    ...(payload.to_amount ? { toAmount: payload.to_amount } : {}),
    ...(payload.error_message ? { errorMessage: payload.error_message } : {}),
  };
}
