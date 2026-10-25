"""Pure helpers in scanner.py and watchlists.py, plus server tool wiring."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import scanner
import watchlists


def test_iv_rank_tries_known_attribute_names():
    assert scanner._iv_rank(SimpleNamespace(implied_volatility_index_rank="0.42")) == 0.42
    assert scanner._iv_rank(SimpleNamespace(tos_implied_volatility_index_rank=0.1)) == 0.1
    assert scanner._iv_rank(SimpleNamespace(iv_rank="bad", )) is None
    assert scanner._iv_rank(SimpleNamespace()) is None


def test_scan_filters_and_sorts(monkeypatch):
    metrics = [
        SimpleNamespace(symbol="AAPL", implied_volatility_index_rank="0.25", liquidity_rating=4, beta="1.2"),
        SimpleNamespace(symbol="MSFT", implied_volatility_index_rank="0.61", liquidity_rating=4, beta="0.9"),
        SimpleNamespace(symbol="KO", implied_volatility_index_rank=None, liquidity_rating=3, beta="0.6"),
        SimpleNamespace(symbol="JPM", implied_volatility_index_rank="0.555", liquidity_rating=4, beta="1.1"),
    ]

    async def fake_metrics(session, symbols):
        return metrics

    monkeypatch.setattr(scanner, "get_market_metrics", fake_metrics)
    rows = asyncio.run(scanner.scan_symbols(None, ["AAPL", "MSFT", "KO", "JPM"], min_iv_rank=50))
    assert [r["symbol"] for r in rows] == ["MSFT", "JPM"]
    assert rows[0]["iv_rank"] == 61.0
    assert asyncio.run(scanner.scan_symbols(None, [])) == []


def test_watchlist_symbols_accept_dicts_and_objects():
    wl = SimpleNamespace(
        watchlist_entries=[{"symbol": "AAPL"}, {"Symbol": "MSFT"}, SimpleNamespace(symbol="KO"), {"other": 1}]
    )
    assert watchlists._symbols(wl) == ["AAPL", "MSFT", "KO"]
    assert watchlists._symbols(SimpleNamespace(watchlist_entries=None)) == []


def test_server_exposes_expected_tools_and_gates_writes(monkeypatch):
    import server

    names = set(server.mcp.tools)
    assert {"preview_order", "place_order", "preview_option_order", "place_option_order"} <= names
    assert len(names) == 14
    assert {"get_monthly_returns", "get_twr_vs_index"} <= names

    # preview_* never forwards a confirm, so it can never go live even with all
    # gates open on the environment side.
    calls = []

    async def fake_ctx():
        return None, None

    async def fake_build(*a, **k):
        return "ORDER"

    async def fake_safe_place(account, session, order, *, confirm=""):
        calls.append(confirm)
        return {"status": "x"}

    monkeypatch.setattr(server, "_ctx", fake_ctx)
    monkeypatch.setattr(server, "build_equity_order", fake_build)
    monkeypatch.setattr(server, "safe_place", fake_safe_place)
    asyncio.run(server.preview_order("AAPL", 1, 100.0))
    asyncio.run(server.place_order("AAPL", 1, 100.0, confirm="CONFIRM"))
    assert calls == ["", "CONFIRM"]
