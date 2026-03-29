const BASE_URL = "https://api.suwappu.bot/v1/agent";
const CHAIN = "base", FROM_TOKEN = "USDC", TO_TOKEN = "ETH";
const BUY_AMOUNT = "100", PRICE_TARGET = 2000.0, POLL_INTERVAL = 30_000, MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function api(path: string, opts: RequestInit & { params?: Record<string,string> } = {}, key?: string) {
  const { params, ...rest } = opts;
  let url = `${BASE_URL}${path}`;
  if (params) url += `?${new URLSearchParams(params)}`;
  const h: Record<string,string> = { "Content-Type": "application/json", ...(rest.headers as Record<string,string>) };
  if (key) h.Authorization = `Bearer ${key}`;
  const r = await fetch(url, { ...rest, headers: h });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.status === 204 ? {} : r.json();
}

async function main() {
  let key = process.env.SUWAPPU_API_KEY;
  if (!key) { const d = await api("/register", { method: "POST", body: JSON.stringify({ name: `bot-${Date.now()}` }) }); key = d.agent.api_key; console.log(`Registered.\nexport SUWAPPU_API_KEY=${key}\n`); }
  const wd = await api("/wallets", {}, key);
  if (!wd.wallets?.length) { const w = await api("/wallets", { method: "POST" }, key); console.log(`Fund ${w.wallet.address} with ${FROM_TOKEN} on ${CHAIN}`); process.exit(0); }
  console.log(`Wallet: ${wd.wallets[0].address}\nTarget: ${TO_TOKEN} < $${PRICE_TARGET}\n`);
  let retries = 0;
  while (true) {
    try {
      const pd = await api("/prices", { params: { symbols: TO_TOKEN } }, key);
      const price = pd.prices?.[TO_TOKEN]?.usd ?? 0;
      if (price < PRICE_TARGET) {
        console.log(`${TO_TOKEN}: $${price.toFixed(2)} -- BUYING!`);
        const q = await api("/quote", { method: "POST", body: JSON.stringify({ from_token: FROM_TOKEN, to_token: TO_TOKEN, amount: BUY_AMOUNT, chain: CHAIN }) }, key);
        const s = await api("/swap/execute", { method: "POST", body: JSON.stringify({ quote_id: q.quote_id }) }, key);
        while (true) { const st = await api(`/swap/status/${s.swap_id}`, {}, key); console.log(`  ${st.status}`); if (st.status === "completed" || st.status === "failed") break; await sleep(5000); }
      } else console.log(`${TO_TOKEN}: $${price.toFixed(2)} (target: <$${PRICE_TARGET})`);
      retries = 0;
    } catch (e: any) { if (e.message?.includes("429")) { retries++; await sleep(Math.min(60000, POLL_INTERVAL * retries)); if (retries >= MAX_RETRIES) process.exit(1); continue; } if (++retries >= MAX_RETRIES) process.exit(1); }
    await sleep(POLL_INTERVAL);
  }
}
main().catch(console.error);
