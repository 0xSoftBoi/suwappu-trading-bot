const API_BASE_URL = (process.env.SUWAPPU_API_URL ?? "https://api.suwappu.bot").replace(/\/$/, "");

export interface CurrentQuote {
  id: string;
  toAmount: string;
  dex: string;
  expiresInSeconds?: number;
}

export interface SwapSimulation {
  success?: boolean;
  reason?: string;
  gasEstimate?: string;
  amountOut?: string;
  [key: string]: unknown;
}

export interface ManagedSwapResult {
  swapId: string;
  status: string;
  txHash?: string;
  pollUrl?: string;
}

async function request<T>(
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
  const response = await fetch(`${API_BASE_URL}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Suwappu API error ${response.status}: ${text || response.statusText}`);
  }

  return (text ? JSON.parse(text) : {}) as T;
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
    throw new Error(`No valid USD price returned for ${symbol}`);
  }

  return price;
}

export async function getPrice(
  apiKey: string,
  symbol: string,
  chain: string,
): Promise<number> {
  const payload = await request<{ prices?: Record<string, { usd?: string | number }> }>(
    apiKey,
    "GET",
    "/v1/agent/prices",
    { params: { symbols: symbol, chain } },
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
    quote_id?: string;
    amount_out?: string | number;
    dex?: string;
    expires_in_seconds?: number;
  }>(apiKey, "POST", "/v1/agent/quote", {
    json: {
      from_token: args.from,
      to_token: args.to,
      amount: args.amount,
      chain: args.chain,
      wallet_address: args.walletAddress,
    },
  });

  if (!payload.quote_id || payload.amount_out === undefined) {
    throw new Error("Malformed quote response");
  }

  return {
    id: payload.quote_id,
    toAmount: String(payload.amount_out),
    dex: String(payload.dex ?? ""),
    ...(typeof payload.expires_in_seconds === "number"
      ? { expiresInSeconds: payload.expires_in_seconds }
      : {}),
  };
}

export function simulateSwap(
  apiKey: string,
  quoteId: string,
  walletAddress: string,
): Promise<SwapSimulation> {
  return request(apiKey, "POST", "/v1/agent/swap/simulate", {
    json: { quote_id: quoteId, wallet_address: walletAddress },
  });
}

export async function executeManagedSwap(
  apiKey: string,
  quoteId: string,
): Promise<ManagedSwapResult> {
  const payload = await request<{
    swap_id?: string | number;
    status?: string;
    tx_hash?: string | null;
    tracking?: { poll_url?: string };
  }>(apiKey, "POST", "/v1/agent/swap/execute", {
    json: { quote_id: quoteId },
  });

  if (payload.swap_id === undefined || typeof payload.status !== "string") {
    throw new Error("Malformed managed swap response");
  }

  return {
    swapId: String(payload.swap_id),
    status: payload.status,
    ...(payload.tx_hash ? { txHash: payload.tx_hash } : {}),
    ...(payload.tracking?.poll_url ? { pollUrl: payload.tracking.poll_url } : {}),
  };
}
