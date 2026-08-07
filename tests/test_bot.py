"""Regression tests for the preview-only Python companion."""
from __future__ import annotations

import time
import unittest
from unittest.mock import patch

import bot


class PythonPreviewTests(unittest.TestCase):
    def test_reference_price_does_not_invent_chain_parameter(self) -> None:
        captured: dict[str, object] = {}

        def fake_request(method, path, headers, *, params=None, payload=None):
            captured.update(method=method, path=path, params=params, payload=payload)
            return {"prices": {"ETH": {"usd": "1995.88"}}}

        with patch.object(bot, "request_json", side_effect=fake_request):
            self.assertEqual(bot.get_reference_price({"Authorization": "Bearer x"}, "eth"), 1995.88)
        self.assertEqual(captured["params"], {"symbols": "eth"})
        self.assertNotIn("chain", captured["params"])

    def test_usdc_cap_fails_closed(self) -> None:
        self.assertEqual(bot.require_usdc_amount("100", "250"), 100)
        with self.assertRaisesRegex(ValueError, "exceeds"):
            bot.require_usdc_amount("251", "250")
        with self.assertRaisesRegex(ValueError, "positive"):
            bot.require_usdc_amount("100", "0")

    def test_conservative_route_price_uses_minimum_output_and_gas(self) -> None:
        quote = bot.Quote(
            quote_id="q1",
            amount_in="100",
            amount_out="0.052",
            amount_out_min="0.05",
            estimated_gas_usd=2,
            reported_route_fee_usd=0.3,
            dex="router",
            expires_at=time.time() + 60,
        )
        self.assertEqual(bot.conservative_acquisition_price(100, quote), 2040)

    def test_missing_gas_or_stale_quote_cannot_be_promoted(self) -> None:
        missing_gas = bot.Quote("q1", "100", "0.052", "0.05", None, None, "", time.time() + 60)
        with self.assertRaisesRegex(RuntimeError, "estimated_gas_usd"):
            bot.conservative_acquisition_price(100, missing_gas)

        stale = bot.Quote("q2", "100", "0.052", "0.05", 1, None, "", time.time() + 4)
        with self.assertRaisesRegex(RuntimeError, "5 seconds"):
            bot.conservative_acquisition_price(100, stale)

    def test_quote_validation_rejects_minimum_above_output(self) -> None:
        with patch.object(
            bot,
            "request_json",
            return_value={
                "success": True,
                "quote_id": "q1",
                "amount_in": "100",
                "amount_out": "0.05",
                "amount_out_min": "0.06",
                "estimated_gas_usd": "1",
                "expires_in_seconds": 60,
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "amount_out_min exceeds"):
                bot.get_quote({}, "USDC", "ETH", "100", "base")


if __name__ == "__main__":
    unittest.main()
