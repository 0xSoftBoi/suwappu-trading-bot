#!/usr/bin/env python3
"""Preview-only Python companion for the Suwappu Trading Bot."""
from __future__ import annotations

import argparse
import json
import math
import os
import signal
import sys
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_API_BASE_URL = "https://api.suwappu.bot"
DEFAULT_MAX_TRADE_USDC = "1000"
DEFAULT_OPERATION_TIMEOUT_MS = 25_000


def api_base_url() -> str:
    return os.environ.get("SUWAPPU_API_URL", DEFAULT_API_BASE_URL).rstrip("/")


def operation_timeout_seconds() -> float:
    raw = os.environ.get(
        "SUWAPPU_OPERATION_TIMEOUT_MS", str(DEFAULT_OPERATION_TIMEOUT_MS)
    )
    try:
        milliseconds = float(raw)
    except ValueError as error:
        raise RuntimeError(
            "SUWAPPU_OPERATION_TIMEOUT_MS must be between 100 and 30000 milliseconds"
        ) from error
    if not math.isfinite(milliseconds) or not 100 <= milliseconds <= 30_000:
        raise RuntimeError(
            "SUWAPPU_OPERATION_TIMEOUT_MS must be between 100 and 30000 milliseconds"
        )
    return milliseconds / 1000


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value or value != value.strip():
        raise RuntimeError(
            f"{name} is missing/invalid"
            + (
                "; register an agent at https://api.suwappu.bot/v1/agent/register"
                if name == "SUWAPPU_API_KEY"
                else ""
            )
        )
    return value


def request_json(
    method: str,
    path: str,
    headers: dict[str, str],
    *,
    params: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    query = urlencode(params or {})
    url = f"{api_base_url()}/v1/agent{path}" + (f"?{query}" if query else "")
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        url,
        data=body,
        headers=headers,
        method=method,
    )
    with urlopen(request, timeout=operation_timeout_seconds()) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError(f"Malformed Suwappu response from {path}")
    return data


def positive_number(value: Any, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"Malformed Suwappu response: {field} must be positive") from error
    if not math.isfinite(number) or number <= 0:
        raise RuntimeError(f"Malformed Suwappu response: {field} must be positive")
    return number


def optional_usd(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        parsed = float(str(value).replace("$", "").replace(",", "").strip())
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) and parsed >= 0 else None


def token_symbol(value: Any, field: str) -> str:
    if isinstance(value, dict):
        value = value.get("symbol")
    if isinstance(value, str) and value.strip():
        return value.strip().upper()
    raise RuntimeError(f"Malformed Suwappu response: missing {field}")


def get_reference_price(headers: dict[str, str], token: str) -> float:
    """Return the chain-neutral reference feed. It is never route liquidity."""
    data = request_json("GET", "/prices", headers, params={"symbols": token})
    if data.get("success") is not True:
        raise RuntimeError("Malformed prices response: missing success=true")
    prices = data.get("prices")
    if not isinstance(prices, dict):
        raise RuntimeError(f"No valid USD reference price returned for {token}")
    info = next(
        (
            value
            for symbol, value in prices.items()
            if str(symbol).upper() == token.upper() and isinstance(value, dict)
        ),
        None,
    )
    try:
        price = float(info.get("usd")) if info else 0.0
    except (TypeError, ValueError):
        price = 0.0
    if not math.isfinite(price) or price <= 0:
        raise RuntimeError(f"No valid USD reference price returned for {token}")
    return price


@dataclass(frozen=True)
class Quote:
    quote_id: str
    amount_in: str
    amount_out: str
    amount_out_min: str
    estimated_gas_usd: float | None
    reported_route_fee_usd: float | None
    dex: str
    expires_at: float


def get_quote(
    headers: dict[str, str],
    from_token: str,
    to_token: str,
    amount: str,
    chain: str,
) -> Quote:
    data = request_json(
        "POST",
        "/quote",
        headers,
        payload={
            "from_token": from_token,
            "to_token": to_token,
            "amount": amount,
            "chain": chain,
        },
    )
    quote_id = data.get("quote_id")
    if data.get("success") is not True or not isinstance(quote_id, str) or not quote_id:
        raise RuntimeError("Malformed quote response: missing success/quote_id")
    returned_from = token_symbol(data.get("from_token"), "from_token")
    returned_to = token_symbol(data.get("to_token"), "to_token")
    if returned_from != from_token.strip().upper() or returned_to != to_token.strip().upper():
        raise RuntimeError("Malformed quote response: returned token pair did not match request")
    amount_in = positive_number(data.get("amount_in"), "amount_in")
    amount_out = positive_number(data.get("amount_out"), "amount_out")
    amount_out_min = positive_number(data.get("amount_out_min"), "amount_out_min")
    requested = positive_number(amount, "requested amount")
    if amount_out_min > amount_out:
        raise RuntimeError("Malformed quote response: amount_out_min exceeds amount_out")
    if abs(amount_in - requested) > max(1e-9, requested * 1e-9):
        raise RuntimeError("Malformed quote response: amount_in did not match request")
    expires_in = positive_number(data.get("expires_in_seconds"), "expires_in_seconds")
    return Quote(
        quote_id=quote_id,
        amount_in=str(data["amount_in"]),
        amount_out=str(data["amount_out"]),
        amount_out_min=str(data["amount_out_min"]),
        estimated_gas_usd=optional_usd(data.get("estimated_gas_usd")),
        reported_route_fee_usd=optional_usd(data.get("bridge_fee_usd")),
        dex=str(data.get("dex") or ""),
        expires_at=time.time() + expires_in,
    )


def require_usdc_amount(amount_text: str, cap_text: str) -> float:
    try:
        amount = float(amount_text)
        cap = float(cap_text)
    except ValueError as error:
        raise ValueError("amount and SUWAPPU_MAX_TRADE_USDC must be numbers") from error
    if not math.isfinite(amount) or amount <= 0:
        raise ValueError("--amount must be a positive USDC amount")
    if not math.isfinite(cap) or cap <= 0:
        raise ValueError("SUWAPPU_MAX_TRADE_USDC must be a positive number")
    if amount > cap:
        raise ValueError(f"--amount {amount:g} USDC exceeds SUWAPPU_MAX_TRADE_USDC={cap:g}")
    return amount


def conservative_acquisition_price(input_usdc: float, quote: Quote) -> float:
    if quote.estimated_gas_usd is None:
        raise RuntimeError("Quote is missing estimated_gas_usd; refusing price-target promotion")
    if quote.expires_at <= time.time() + 5:
        raise RuntimeError("Quote has 5 seconds or less remaining; request a fresh route")
    minimum_output = positive_number(quote.amount_out_min, "amount_out_min")
    return (input_usdc + quote.estimated_gas_usd) / minimum_output


def validate_args(parser: argparse.ArgumentParser, args: argparse.Namespace) -> float:
    if args.execute:
        parser.error(
            "the Python companion is preview-only; use `bun src/cli.ts --execute` "
            "for the durable managed-execution reference"
        )
    if args.from_token.strip().upper() != "USDC":
        parser.error("this price-target reference currently requires --from-token USDC")
    if not args.to_token.strip() or args.to_token.strip().upper() == "USDC":
        parser.error("--to-token must be a non-USDC token symbol")
    if not args.chain.strip():
        parser.error("--chain must not be empty")
    try:
        amount = require_usdc_amount(
            args.amount,
            os.environ.get("SUWAPPU_MAX_TRADE_USDC", DEFAULT_MAX_TRADE_USDC),
        )
    except ValueError as error:
        parser.error(str(error))
    if not math.isfinite(args.target) or args.target <= 0:
        parser.error("--target must be positive")
    if args.interval < 10:
        parser.error("--interval must be at least 10 seconds")
    if args.max_retries <= 0:
        parser.error("--max-retries must be positive")
    return amount


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Preview-only Python companion for the Suwappu Trading Bot"
    )
    parser.add_argument("--chain", default="base", help="chain to quote on (default: base)")
    parser.add_argument("--from-token", default="USDC", dest="from_token")
    parser.add_argument("--to-token", default="ETH", dest="to_token")
    parser.add_argument("--amount", default="100", help="USDC amount per candidate action")
    parser.add_argument("--target", type=float, default=2000)
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="unsupported fail-closed compatibility flag; managed execution is TypeScript-only",
    )
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--once", action="store_true", help="run one preview evaluation and exit")
    parser.add_argument("--max-retries", type=int, default=5)
    args = parser.parse_args()
    amount_usdc = validate_args(parser, args)

    api_key = require_env("SUWAPPU_API_KEY")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    stopped = False

    def shutdown(_sig: int, _frame: object) -> None:
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    if not args.json:
        print("Suwappu Price-Target Python Preview")
        print(f"  Chain: {args.chain} | Candidate: {amount_usdc:g} USDC → {args.to_token}")
        print(f"  Conservative route target: < ${args.target:g} | Interval: {args.interval}s")
        print("  Mode: PREVIEW ONLY (never submits a transaction)\n")

    retries = 0
    while not stopped:
        try:
            reference_price = get_reference_price(headers, args.to_token)
            if reference_price >= args.target:
                result = {
                    "token": args.to_token,
                    "referencePriceUsd": reference_price,
                    "targetUsd": args.target,
                    "action": "wait",
                    "referenceFeed": "chain-neutral",
                }
                if args.json:
                    print(json.dumps(result), flush=True)
                else:
                    print(f"{args.to_token} reference: ${reference_price:.2f} (target: < ${args.target:g})")
            else:
                quote = get_quote(
                    headers,
                    "USDC",
                    args.to_token,
                    f"{amount_usdc:g}",
                    args.chain,
                )
                route_price = conservative_acquisition_price(amount_usdc, quote)
                if route_price >= args.target:
                    action = "quote_blocked"
                else:
                    action = "would_buy"
                result = {
                    "token": args.to_token,
                    "chain": args.chain,
                    "referencePriceUsd": reference_price,
                    "targetUsd": args.target,
                    "action": action,
                    "conservativeRoutePriceUsd": route_price,
                    "quote": {
                        "id": quote.quote_id,
                        "fromAmount": quote.amount_in,
                        "fromToken": "USDC",
                        "toAmount": quote.amount_out,
                        "toAmountMin": quote.amount_out_min,
                        "toToken": args.to_token,
                        "estimatedGasUsd": quote.estimated_gas_usd,
                        "dex": quote.dex or "auto",
                    },
                }
                if args.json:
                    print(json.dumps(result), flush=True)
                elif action == "would_buy":
                    print(f"{args.to_token} reference: ${reference_price:.2f} < ${args.target:g} — WOULD BUY")
                    print(
                        f"  Conservative route: ${route_price:.2f}/{args.to_token} | "
                        f"{quote.amount_in} USDC → min {quote.amount_out_min} {args.to_token}"
                    )
                else:
                    print(f"{args.to_token} reference passed, but route is ${route_price:.2f}/{args.to_token} — BLOCKED")
            retries = 0
            if args.once:
                break
        except HTTPError as error:
            retries += 1
            status = error.code
            if args.once:
                print(f"Error: Suwappu API error {status}", file=sys.stderr)
                raise SystemExit(1) from error
            if status == 429 and retries < args.max_retries:
                wait = min(120, args.interval * retries)
                print(f"Rate limited. Waiting {wait}s... ({retries}/{args.max_retries})", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"Error: Suwappu API error {status}", file=sys.stderr)
            if retries >= args.max_retries:
                raise SystemExit(1) from error
        except Exception as error:
            retries += 1
            print(f"Error: {error}", file=sys.stderr)
            if args.once:
                raise SystemExit(1) from error
            if retries >= args.max_retries:
                raise SystemExit(1) from error

        if not stopped:
            time.sleep(args.interval)


if __name__ == "__main__":
    main()
