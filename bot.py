#!/usr/bin/env python3
"""Preview-first Suwappu price-target trading example."""
from __future__ import annotations

import argparse
import json
import math
import os
import signal
import sys
import time
from typing import Any

import requests

API_BASE_URL = os.environ.get("SUWAPPU_API_URL", "https://api.suwappu.bot").rstrip("/")
BASE_URL = f"{API_BASE_URL}/v1/agent"
REQUEST_TIMEOUT = 30
trades_count = 0
json_mode = False


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"Error: {name} not set", file=sys.stderr)
        if name == "SUWAPPU_API_KEY":
            print(
                "  Register an agent at https://api.suwappu.bot/v1/agent/register",
                file=sys.stderr,
            )
        raise SystemExit(1)
    return value


def request_json(
    method: str,
    path: str,
    headers: dict[str, str],
    *,
    params: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response = requests.request(
        method,
        f"{BASE_URL}{path}",
        headers=headers,
        params=params,
        json=payload,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"Malformed Suwappu response from {path}")
    return data


def get_price(headers: dict[str, str], token: str, chain: str) -> float:
    data = request_json(
        "GET",
        "/prices",
        headers,
        params={"symbols": token, "chain": chain},
    )
    prices = data.get("prices")
    if not isinstance(prices, dict):
        raise RuntimeError(f"No valid USD price returned for {token}")

    info = next(
        (
            value
            for symbol, value in prices.items()
            if symbol.upper() == token.upper() and isinstance(value, dict)
        ),
        None,
    )
    try:
        price = float(info.get("usd")) if info else 0.0
    except (TypeError, ValueError):
        price = 0.0

    if not math.isfinite(price) or price <= 0:
        raise RuntimeError(f"No valid USD price returned for {token}")
    return price


def get_quote(
    headers: dict[str, str],
    from_token: str,
    to_token: str,
    amount: str,
    chain: str,
    wallet_address: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "from_token": from_token,
        "to_token": to_token,
        "amount": amount,
        "chain": chain,
    }
    if wallet_address:
        payload["wallet_address"] = wallet_address
    return request_json("POST", "/quote", headers, payload=payload)


def simulate_swap(
    headers: dict[str, str],
    quote_id: str,
    wallet_address: str,
) -> dict[str, Any]:
    return request_json(
        "POST",
        "/swap/simulate",
        headers,
        payload={"quote_id": quote_id, "wallet_address": wallet_address},
    )


def execute_swap(headers: dict[str, str], quote_id: str) -> dict[str, Any]:
    return request_json(
        "POST",
        "/swap/execute",
        headers,
        payload={"quote_id": quote_id},
    )


def shutdown(_sig: int, _frame: object) -> None:
    stream = sys.stderr if json_mode else sys.stdout
    print(f"\nStopped. {trades_count} managed swaps submitted.", file=stream)
    raise SystemExit(0)


def validate_args(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    try:
        amount = float(args.amount)
    except ValueError:
        parser.error("--amount must be a positive source-token amount")
        return

    if not math.isfinite(amount) or amount <= 0:
        parser.error("--amount must be a positive source-token amount")
    if not math.isfinite(args.target) or args.target <= 0:
        parser.error("--target must be positive")
    if args.interval < 10:
        parser.error("--interval must be at least 10 seconds")
    if args.max_retries <= 0:
        parser.error("--max-retries must be positive")
    if args.max_trades <= 0:
        parser.error("--max-trades must be positive")
    if args.execute and args.dry_run:
        parser.error("--execute and --dry-run cannot be used together")


def main() -> None:
    global json_mode, trades_count

    parser = argparse.ArgumentParser(
        description="Preview-first Suwappu price-target trading example"
    )
    parser.add_argument("--chain", default="base", help="chain to trade on (default: base)")
    parser.add_argument(
        "--from-token",
        default="USDC",
        dest="from_token",
        help="source token (default: USDC)",
    )
    parser.add_argument(
        "--to-token",
        default="ETH",
        dest="to_token",
        help="token to buy (default: ETH)",
    )
    parser.add_argument(
        "--amount",
        default="100",
        help="source-token amount per trade (default: 100)",
    )
    parser.add_argument(
        "--target",
        type=float,
        default=2000,
        help="buy below this USD price (default: 2000)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=30,
        help="poll interval seconds (minimum: 10)",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="enable managed-wallet swap submission",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="deprecated; preview is already the default",
    )
    parser.add_argument("--json", action="store_true", help="write JSON objects to stdout")
    parser.add_argument(
        "--max-retries",
        type=int,
        default=5,
        help="max consecutive errors before exit (default: 5)",
    )
    parser.add_argument(
        "--max-trades",
        type=int,
        default=1,
        help="managed swaps before stopping (default: 1)",
    )
    args = parser.parse_args()
    validate_args(parser, args)
    json_mode = args.json

    api_key = require_env("SUWAPPU_API_KEY")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    wallet_address: str | None = None
    if args.execute:
        if os.environ.get("SUWAPPU_ALLOW_MANAGED_EXECUTION") != "1":
            parser.error(
                "managed execution is locked; set SUWAPPU_ALLOW_MANAGED_EXECUTION=1 "
                "as well as --execute"
            )
        wallet_address = require_env("SUWAPPU_WALLET_ADDRESS")

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    if not args.json:
        print("Suwappu Trading Bot")
        print(
            f"  Chain: {args.chain} | Buy: {args.amount} "
            f"{args.from_token} → {args.to_token}"
        )
        print(f"  Target: < ${args.target} | Interval: {args.interval}s")
        if args.execute:
            print(
                "  Mode: MANAGED EXECUTION "
                f"(simulate first, max {args.max_trades} trade"
                f"{'' if args.max_trades == 1 else 's'})"
            )
        else:
            print("  Mode: PREVIEW (quotes only; no transaction submission)")
        print()

    retries = 0

    while True:
        try:
            price = get_price(headers, args.to_token, args.chain)

            if price >= args.target:
                if args.json:
                    print(
                        json.dumps(
                            {
                                "token": args.to_token,
                                "chain": args.chain,
                                "price": price,
                                "target": args.target,
                                "action": "wait",
                            }
                        ),
                        flush=True,
                    )
                else:
                    print(
                        f"{args.to_token}: ${price:.2f} "
                        f"(target: < ${args.target})"
                    )
                retries = 0
                time.sleep(args.interval)
                continue

            quote = get_quote(
                headers,
                args.from_token,
                args.to_token,
                args.amount,
                args.chain,
                wallet_address if args.execute else None,
            )
            quote_id = str(quote.get("quote_id") or "")
            if not quote_id:
                raise RuntimeError("Suwappu returned a quote without quote_id")

            if not args.execute:
                if args.json:
                    print(
                        json.dumps(
                            {
                                "token": args.to_token,
                                "chain": args.chain,
                                "price": price,
                                "target": args.target,
                                "action": "would_buy",
                                "quote": {
                                    "id": quote_id,
                                    "fromAmount": args.amount,
                                    "fromToken": args.from_token,
                                    "toAmount": quote.get("amount_out"),
                                    "toToken": args.to_token,
                                    "dex": quote.get("dex") or "auto",
                                },
                            }
                        ),
                        flush=True,
                    )
                else:
                    print(
                        f"{args.to_token}: ${price:.2f} < ${args.target} — WOULD BUY"
                    )
                    print(
                        f"  Quote: {args.amount} {args.from_token} → "
                        f"{quote.get('amount_out', '?')} {args.to_token} "
                        f"(via {quote.get('dex') or 'auto'})"
                    )
            else:
                assert wallet_address is not None
                simulation = simulate_swap(headers, quote_id, wallet_address)
                if simulation.get("success") is not True:
                    raise RuntimeError(
                        "Swap simulation failed: "
                        f"{simulation.get('reason') or 'no success response'}"
                    )

                swap = execute_swap(headers, quote_id)
                if swap.get("swap_id") is None or not swap.get("status"):
                    raise RuntimeError("Malformed managed swap response")
                trades_count += 1

                if args.json:
                    print(
                        json.dumps(
                            {
                                "token": args.to_token,
                                "chain": args.chain,
                                "price": price,
                                "target": args.target,
                                "action": "submitted",
                                "quoteId": quote_id,
                                "simulation": {"success": True},
                                "swap": {
                                    "swapId": str(swap["swap_id"]),
                                    "status": swap["status"],
                                    "txHash": swap.get("tx_hash"),
                                    "pollUrl": (swap.get("tracking") or {}).get("poll_url"),
                                },
                            }
                        ),
                        flush=True,
                    )
                else:
                    print(
                        f"{args.to_token}: ${price:.2f} < ${args.target} — EXECUTING"
                    )
                    print(
                        f"  Quote: {args.amount} {args.from_token} → "
                        f"{quote.get('amount_out', '?')} {args.to_token} "
                        f"(via {quote.get('dex') or 'auto'})"
                    )
                    print("  Simulation: passed")
                    print(
                        f"  Swap: {swap['status']} | ID: {swap['swap_id']} | "
                        f"TX: {swap.get('tx_hash') or 'pending'}"
                    )

                if trades_count >= args.max_trades:
                    if not args.json:
                        print(f"Reached --max-trades {args.max_trades}; stopping.")
                    return

            retries = 0
        except requests.exceptions.HTTPError as error:
            retries += 1
            if error.response is not None and error.response.status_code == 429:
                wait = min(120, args.interval * retries)
                print(
                    f"Rate limited. Waiting {wait}s... "
                    f"({retries}/{args.max_retries})",
                    file=sys.stderr,
                )
                if retries >= args.max_retries:
                    raise SystemExit(1) from error
                time.sleep(wait)
                continue

            print(f"Error: {error}", file=sys.stderr)
            if retries >= args.max_retries:
                raise SystemExit(1) from error
        except Exception as error:
            retries += 1
            print(f"Error: {error}", file=sys.stderr)
            if retries >= args.max_retries:
                raise SystemExit(1) from error

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
