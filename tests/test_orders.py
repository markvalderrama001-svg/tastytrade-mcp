"""Order construction: debit/credit sign derivation, parsing, contract lookup."""
from __future__ import annotations

import asyncio
from decimal import Decimal

import pytest

import orders
from tastytrade.order import OrderAction, OrderTimeInForce


@pytest.mark.parametrize(
    "action, expected",
    [
        ("BUY_TO_OPEN", Decimal("-2.50")),
        ("BUY_TO_CLOSE", Decimal("-2.50")),
        ("SELL_TO_OPEN", Decimal("2.50")),
        ("SELL_TO_CLOSE", Decimal("2.50")),
    ],
)
def test_sign_follows_action(action, expected):
    act = orders._resolve_action(action)
    assert orders._signed_price(2.50, act) == expected


@pytest.mark.parametrize("raw", [2.5, -2.5])
def test_caller_sign_is_ignored(raw):
    # Claude cannot flip a debit into a credit by passing a negative price.
    assert orders._signed_price(raw, OrderAction.BUY_TO_OPEN) == Decimal("-2.5")
    assert orders._signed_price(raw, OrderAction.SELL_TO_OPEN) == Decimal("2.5")


def test_price_uses_decimal_not_float():
    assert orders._signed_price(0.1, OrderAction.SELL_TO_OPEN) == Decimal("0.1")


@pytest.mark.parametrize("raw", ["buy_to_open", " Sell_To_Close "])
def test_action_parsing_is_forgiving_on_case(raw):
    assert isinstance(orders._resolve_action(raw), OrderAction)


@pytest.mark.parametrize("raw", ["BUY", "SELL_SHORT", "", "BUY TO OPEN"])
def test_unknown_action_rejected(raw):
    with pytest.raises(ValueError):
        orders._resolve_action(raw)


@pytest.mark.parametrize("raw, ok", [("c", True), ("CALL", True), ("p", True), ("Put", True), ("X", False)])
def test_option_type_parsing(raw, ok):
    if ok:
        orders._resolve_option_type(raw)
    else:
        with pytest.raises(ValueError):
            orders._resolve_option_type(raw)


def test_tif_parsing():
    assert orders._resolve_tif("gtc") is OrderTimeInForce.GTC
    with pytest.raises(ValueError):
        orders._resolve_tif("FOREVER")


def test_parse_date_normalises_and_rejects_bad_input():
    assert orders._parse_date(" 2026-12-18 ") == "2026-12-18"
    with pytest.raises(ValueError):
        orders._parse_date("12/18/2026")


def test_equity_order_buy_is_debit():
    order = asyncio.run(orders.build_equity_order(None, "aapl", 10, 187.5, "BUY_TO_OPEN"))
    assert order.price == Decimal("-187.5")
    assert order.legs[0].symbol == "AAPL"
    assert order.legs[0].quantity == Decimal("10")
    assert order.time_in_force is OrderTimeInForce.DAY


def test_option_order_finds_contract_and_credits_a_short_put(fake_chain):
    order = asyncio.run(
        orders.build_option_order(None, "AAPL", "2026-12-18", 185, "P", 1, 3.20, "SELL_TO_OPEN")
    )
    assert order.legs[0].symbol == "AAPL  261218P00185000"
    assert order.price == Decimal("3.2")


def test_option_lookup_matches_fractional_strikes(fake_chain):
    order = asyncio.run(
        orders.build_option_order(None, "AAPL", "2026-12-18", 192.5, "CALL", 2, 1.05, "BUY_TO_OPEN")
    )
    assert order.legs[0].symbol == "AAPL  261218C00192500"
    assert order.price == Decimal("-1.05")


def test_missing_contract_raises_helpful_error(fake_chain):
    with pytest.raises(ValueError, match="No P AAPL 999"):
        asyncio.run(orders.build_option_order(None, "AAPL", "2026-12-18", 999, "P", 1, 1.0))


def test_list_expirations_and_strikes(fake_chain):
    assert asyncio.run(orders.list_expirations(None, "AAPL")) == ["2026-12-18", "2027-01-15"]
    strikes = asyncio.run(orders.list_strikes(None, "AAPL", "2026-12-18"))
    assert [s["strike"] for s in strikes] == ["185", "190", "192.5"]
    assert strikes[1] == {"strike": "190", "call": True, "put": True}
    assert strikes[0] == {"strike": "185", "call": False, "put": True}
