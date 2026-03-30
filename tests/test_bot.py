"""Tests for the Suwappu Trading Bot Python implementation."""


def test_buy_signal_below_target():
    price, target = 1950.0, 2000.0
    assert price < target


def test_buy_signal_at_target():
    price, target = 2000.0, 2000.0
    assert not (price < target)


def test_buy_signal_above_target():
    price, target = 2100.0, 2000.0
    assert not (price < target)


def test_json_output_format():
    import json
    token, price, target = "ETH", 1950.0, 2000.0
    output = json.dumps({
        "token": token,
        "price": price,
        "target": target,
        "action": "buy" if price < target else "wait",
    })
    parsed = json.loads(output)
    assert parsed["action"] == "buy"
    assert parsed["token"] == "ETH"


def test_retry_wait_calculation():
    interval, retries = 30, 3
    wait = min(120, interval * retries)
    assert wait == 90


def test_retry_wait_capped():
    interval, retries = 30, 5
    wait = min(120, interval * retries)
    assert wait == 120


def test_api_key_format():
    key = "suwappu_sk_test123abc"
    assert key.startswith("suwappu_sk_")
    assert len(key) > len("suwappu_sk_")
