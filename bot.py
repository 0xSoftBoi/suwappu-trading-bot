#!/usr/bin/env python3
"""Suwappu Trading Bot — monitors price and buys on dip."""
import argparse
import os
import signal
import sys
import time

import requests

BASE_URL = "https://api.suwappu.bot/v1/agent"
trades_count = 0


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        print(f"Error: {name} not set", file=sys.stderr)
        if name == "SUWAPPU_API_KEY":
            print('  Get one: curl -X POST https://api.suwappu.bot/v1/agent/register -H "Content-Type: application/json" -d \'{"name":"my-bot"}\'', file=sys.stderr)
        sys.exit(1)
    return val


def get_price(headers: dict, token: str) -> float:
    r = requests.get(f"{BASE_URL}/prices", headers=headers, params={"symbols": token})
    r.raise_for_status()
    return float(r.json().get("prices", {}).get(token, {}).get("usd", 0))


def get_quote(headers: dict, from_t: str, to_t: str, amount: str, chain: str) -> dict:
    r = requests.post(f"{BASE_URL}/quote", headers=headers,
                       json={"from_token": from_t, "to_token": to_t, "amount": amount, "chain": chain})
    r.raise_for_status()
    return r.json()


def execute_swap(headers: dict, quote_id: str) -> dict:
    r = requests.post(f"{BASE_URL}/swap/execute", headers=headers, json={"quote_id": quote_id})
    r.raise_for_status()
    return r.json()


def shutdown(sig, frame):
    print(f"\nStopped. {trades_count} trades executed.")
    sys.exit(0)


def main():
    global trades_count
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    parser = argparse.ArgumentParser(description="Suwappu Trading Bot — buy on price dip")
    parser.add_argument("--chain", default="base", help="chain to trade on (default: base)")
    parser.add_argument("--from-token", default="USDC", dest="from_token", help="token to spend (default: USDC)")
    parser.add_argument("--to-token", default="ETH", dest="to_token", help="token to buy (default: ETH)")
    parser.add_argument("--amount", default="100", help="amount per trade (default: 100)")
    parser.add_argument("--target", type=float, default=2000, help="buy below this price (default: 2000)")
    parser.add_argument("--interval", type=int, default=30, help="poll interval seconds (default: 30)")
    parser.add_argument("--dry-run", action="store_true", help="quote only, don't execute")
    parser.add_argument("--json", action="store_true", help="output as JSON")
    parser.add_argument("--max-retries", type=int, default=5, help="max errors before exit (default: 5)")
    args = parser.parse_args()

    api_key = require_env("SUWAPPU_API_KEY")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    print(f"Suwappu Trading Bot")
    print(f"  Chain: {args.chain} | Buy: {args.amount} {args.from_token} → {args.to_token}")
    print(f"  Target: < ${args.target} | Interval: {args.interval}s")
    if args.dry_run:
        print("  Mode: DRY RUN (quotes only)")
    print()

    retries = 0
    while True:
        try:
            price = get_price(headers, args.to_token)
            if args.json:
                import json
                print(json.dumps({"token": args.to_token, "price": price, "target": args.target, "action": "buy" if price < args.target else "wait"}))
            elif price < args.target:
                print(f"{args.to_token}: ${price:.2f} < ${args.target} — {'WOULD BUY' if args.dry_run else 'BUYING'}!")
                q = get_quote(headers, args.from_token, args.to_token, args.amount, args.chain)
                print(f"  Quote: {args.amount} {args.from_token} → {q.get('amount_out', '?')} {args.to_token}")
                if not args.dry_run:
                    s = execute_swap(headers, q["quote_id"])
                    print(f"  Swap: {s.get('status', 'submitted')}")
                    trades_count += 1
            else:
                print(f"{args.to_token}: ${price:.2f} (target: < ${args.target})")
            retries = 0
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                retries += 1
                wait = min(120, args.interval * retries)
                print(f"Rate limited. Waiting {wait}s... ({retries}/{args.max_retries})", file=sys.stderr)
                time.sleep(wait)
                if retries >= args.max_retries:
                    sys.exit(1)
                continue
            print(f"Error: {e}", file=sys.stderr)
            if (retries := retries + 1) >= args.max_retries:
                sys.exit(1)
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            if (retries := retries + 1) >= args.max_retries:
                sys.exit(1)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
