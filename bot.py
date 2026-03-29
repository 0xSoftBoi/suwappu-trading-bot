#!/usr/bin/env python3
"""Suwappu Trading Bot — monitors price and buys on dip."""
import os, sys, time, requests

BASE_URL = "https://api.suwappu.bot/v1/agent"
CHAIN, FROM_TOKEN, TO_TOKEN = "base", "USDC", "ETH"
BUY_AMOUNT, PRICE_TARGET, POLL_INTERVAL, MAX_RETRIES = "100", 2000.0, 30, 3

def register():
    r = requests.post(f"{BASE_URL}/register", json={"name": f"bot-{int(time.time())}"})
    r.raise_for_status()
    key = r.json()["agent"]["api_key"]
    print(f"Registered. API key: {key[:20]}...")
    return key

def get_price(h, token):
    r = requests.get(f"{BASE_URL}/prices", headers=h, params={"symbols": token})
    r.raise_for_status()
    return float(r.json().get("prices", {}).get(token, {}).get("usd", 0))

def swap(h, fr, to, amt, chain):
    q = requests.post(f"{BASE_URL}/quote", headers=h, json={"from_token": fr, "to_token": to, "amount": amt, "chain": chain})
    q.raise_for_status(); qd = q.json()
    print(f"Quote: {amt} {fr} -> {qd.get('amount_out','?')} {to}")
    s = requests.post(f"{BASE_URL}/swap/execute", headers=h, json={"quote_id": qd["quote_id"]})
    s.raise_for_status(); return s.json()["swap_id"]

def wait(h, sid):
    while True:
        r = requests.get(f"{BASE_URL}/swap/status/{sid}", headers=h).json()
        print(f"  {r['status']}")
        if r["status"] in ("completed", "failed"): return r["status"] == "completed"
        time.sleep(5)

def main():
    key = os.environ.get("SUWAPPU_API_KEY") or register()
    h = {"Authorization": f"Bearer {key}"}
    w = requests.get(f"{BASE_URL}/wallets", headers=h).json()
    if not w.get("wallets"):
        ww = requests.post(f"{BASE_URL}/wallets", headers=h).json()["wallet"]
        print(f"Fund {ww['address']} with {FROM_TOKEN} on {CHAIN}, then restart."); sys.exit(0)
    print(f"Wallet: {w['wallets'][0]['address']}\nMonitoring {TO_TOKEN} < ${PRICE_TARGET}. Ctrl+C to stop.\n")
    retries = 0
    while True:
        try:
            p = get_price(h, TO_TOKEN)
            if p < PRICE_TARGET:
                print(f"{TO_TOKEN}: ${p:.2f} -- BUYING!")
                wait(h, swap(h, FROM_TOKEN, TO_TOKEN, BUY_AMOUNT, CHAIN))
            else:
                print(f"{TO_TOKEN}: ${p:.2f} (target: <${PRICE_TARGET})")
            retries = 0
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429:
                retries += 1; time.sleep(min(60, POLL_INTERVAL * retries))
                if retries >= MAX_RETRIES: sys.exit(1); continue
            if (retries := retries + 1) >= MAX_RETRIES: sys.exit(1)
        except KeyboardInterrupt: print("\nStopped."); sys.exit(0)
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__": main()
