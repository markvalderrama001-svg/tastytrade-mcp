"""Performance math checked against hand-computed numbers. All data synthetic."""
from __future__ import annotations

import asyncio
import io
import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from performance import live
from performance.benchmark import compare_to_benchmarks, fetch_yahoo_total_return, growth_of, monthly_index_returns
from performance.realized import (
    match_realized,
    monthly_realized,
    positions_from_transactions,
    realized_by_strategy,
)
from performance.returns import (
    contributions_vs_gains,
    daily_twr,
    modified_dietz,
    monthly_modified_dietz,
    monthly_twr,
    twr,
)

ROOT = Path(__file__).resolve().parents[1]
D = date


# ---------------- time-weighted return ----------------
def test_deposit_mid_period_does_not_inflate_return():
    # +10% on day 1, then a $5,000 deposit on a flat day 2.
    values = [(D(2026, 1, 2), 10_000), (D(2026, 1, 5), 11_000), (D(2026, 1, 6), 16_000)]
    flows = [(D(2026, 1, 6), 5_000)]
    assert twr(values, flows) == pytest.approx(0.10)
    assert values[-1][1] / values[0][1] - 1 == pytest.approx(0.60)  # the naive number is wrong


def test_flat_market_with_deposit_is_zero_return():
    values = [(D(2026, 1, 2), 10_000), (D(2026, 1, 5), 10_000), (D(2026, 1, 6), 15_000)]
    assert twr(values, [(D(2026, 1, 6), 5_000)]) == pytest.approx(0.0)


def test_withdrawal_does_not_count_as_a_loss():
    # +20% on day 1, then $3,000 out on a flat day 2.
    values = [(D(2026, 1, 2), 10_000), (D(2026, 1, 5), 12_000), (D(2026, 1, 6), 9_000)]
    assert twr(values, [(D(2026, 1, 6), -3_000)]) == pytest.approx(0.20)


def test_twr_chain_links_daily_returns():
    values = [(D(2026, 1, 2), 100), (D(2026, 1, 5), 110), (D(2026, 1, 6), 99)]
    assert [r for _, r in daily_twr(values)] == pytest.approx([0.10, -0.10])
    assert twr(values) == pytest.approx(1.1 * 0.9 - 1)


def test_twr_rejects_non_positive_starting_value():
    with pytest.raises(ValueError):
        twr([(D(2026, 1, 2), 0), (D(2026, 1, 5), 100)])


def test_monthly_twr_splits_on_calendar_months():
    values = [(D(2026, 1, 29), 100), (D(2026, 1, 30), 110), (D(2026, 2, 2), 121), (D(2026, 2, 3), 133.1)]
    rows = monthly_twr(values)
    assert [r["month"] for r in rows] == ["2026-01", "2026-02"]
    assert rows[0]["twr_pct"] == pytest.approx(10.0)
    assert rows[1]["twr_pct"] == pytest.approx(21.0)  # 1.1 * 1.1 - 1


# ---------------- Modified Dietz ----------------
def test_modified_dietz_hand_computed():
    # 100,000 -> 112,000 over 28 days with 10,000 deposited on day 14 (weight 0.5).
    r = modified_dietz(100_000, 112_000, D(2026, 1, 31), D(2026, 2, 28), [(D(2026, 2, 14), 10_000)])
    assert r == pytest.approx(2_000 / 105_000)


def test_modified_dietz_ignores_flows_outside_the_period():
    r = modified_dietz(100, 110, D(2026, 1, 31), D(2026, 2, 28), [(D(2026, 1, 31), 50), (D(2026, 3, 1), 50)])
    assert r == pytest.approx(0.10)


def test_modified_dietz_equals_twr_without_flows():
    values = [(D(2026, 1, 30), 100), (D(2026, 2, 2), 103), (D(2026, 2, 27), 99), (D(2026, 3, 2), 104)]
    tw = {r["month"]: r["twr_pct"] for r in monthly_twr(values)}
    for row in monthly_modified_dietz(values):
        assert row["dietz_pct"] == pytest.approx(tw[row["month"]])


def test_contributions_vs_gains_split():
    values = [(D(2026, 1, 2), 10_000), (D(2026, 1, 5), 11_000), (D(2026, 1, 6), 16_500)]
    split = contributions_vs_gains(values, [(D(2026, 1, 6), 5_000)])
    end = split[-1]
    assert (end["starting_capital"], end["net_contributions"], end["market_gain"]) == (10_000, 5_000, 1_500)
    assert end["starting_capital"] + end["net_contributions"] + end["market_gain"] == end["value"]


# ---------------- realized P&L ----------------
def _fixture_tx():
    data = json.loads((ROOT / "worker" / "fixtures" / "transactions.json").read_text(encoding="utf-8"))
    return data["data"]["items"]


def test_match_realized_agrees_with_worker_matcher():
    closed = {c["symbol"]: c for c in match_realized(_fixture_tx())}
    assert closed["AAPL  261218P00185000"]["realized_pnl"] == 237.72
    assert closed["MSFT"]["realized_pnl"] == 99.95
    assert round(sum(c["realized_pnl"] for c in closed.values()), 2) == 337.67


def test_csp_ror_uses_cash_secured_capital():
    pos = {p["underlying"]: p for p in positions_from_transactions(_fixture_tx())}
    assert pos["AAPL"]["strategy"] == "CSP"
    assert pos["AAPL"]["capital_deployed"] == 18_500.0  # 185 strike x 100
    assert pos["AAPL"]["ror_pct"] == pytest.approx(round(237.72 / 18_500 * 100, 2))
    assert pos["MSFT"]["strategy"] == "stock"
    assert pos["MSFT"]["ror_pct"] == 2.5  # 99.95 on 4,000.00


def _fill(action, symbol, root, qty, price, when, oid, option=True):
    mult = 100 if option else 1
    v = round(qty * price * mult, 2)
    eff = "Credit" if action.startswith("Sell") else "Debit"
    return {
        "transaction-type": "Trade", "action": action, "symbol": symbol, "underlying-symbol": root,
        "instrument-type": "Equity Option" if option else "Equity", "quantity": str(qty),
        "price": str(price), "net-value": f"{v:.2f}", "net-value-effect": eff,
        "executed-at": when, "order-id": oid,
    }


def test_credit_spread_capital_is_max_loss():
    s, l = "XYZ   260320P00050000", "XYZ   260320P00045000"
    tx = [
        _fill("Sell to Open", s, "XYZ", 1, 1.00, "2026-02-02T15:00:00+00:00", 1),
        _fill("Buy to Open", l, "XYZ", 1, 0.40, "2026-02-02T15:00:00+00:00", 1),
        _fill("Buy to Close", s, "XYZ", 1, 0.20, "2026-02-20T15:00:00+00:00", 2),
        _fill("Sell to Close", l, "XYZ", 1, 0.05, "2026-02-20T15:00:00+00:00", 2),
    ]
    [p] = positions_from_transactions(tx)
    assert p["strategy"] == "spread"
    assert p["realized_pnl"] == 45.0          # 60 credit - 15 to close
    assert p["capital_deployed"] == 440.0     # 5 wide x 100 - 60 credit
    assert p["ror_pct"] == pytest.approx(round(45 / 440 * 100, 2))


def test_iron_condor_uses_widest_side():
    legs = [("P", 45, "Buy", 0.30), ("P", 50, "Sell", 0.90), ("C", 60, "Sell", 0.80), ("C", 63, "Buy", 0.30)]
    tx = []
    for right, k, side, px in legs:
        sym = f"XYZ   260320{right}{k * 1000:08d}"
        tx.append(_fill(f"{side} to Open", sym, "XYZ", 1, px, "2026-02-02T15:00:00+00:00", 9))
        tx.append(_fill("Buy to Close" if side == "Sell" else "Sell to Close", sym, "XYZ", 1, 0.01, "2026-03-01T15:00:00+00:00", 10))
    [p] = positions_from_transactions(tx)
    assert p["strategy"] == "spread"
    assert p["capital_deployed"] == pytest.approx(5 * 100 - 110)  # widest side 5, credit 110


def test_debit_calendar_capital_is_debit_paid():
    near, far = "XYZ   260320C00050000", "XYZ   260417C00050000"
    tx = [
        _fill("Sell to Open", near, "XYZ", 1, 1.00, "2026-02-02T15:00:00+00:00", 3),
        _fill("Buy to Open", far, "XYZ", 1, 1.80, "2026-02-02T15:00:00+00:00", 3),
        _fill("Buy to Close", near, "XYZ", 1, 0.50, "2026-03-10T15:00:00+00:00", 4),
        _fill("Sell to Close", far, "XYZ", 1, 1.60, "2026-03-10T15:00:00+00:00", 4),
    ]
    [p] = positions_from_transactions(tx)
    assert p["capital_deployed"] == 80.0
    assert p["realized_pnl"] == 30.0


def test_leap_and_covered_call_labels_and_open_positions_excluded():
    leap = "XYZ   270115C00040000"
    cc = "XYZ   260320C00055000"
    still_open = "XYZ   260417P00045000"
    tx = [
        _fill("Buy to Open", leap, "XYZ", 1, 9.00, "2025-10-14T15:00:00+00:00", 5),
        _fill("Sell to Close", leap, "XYZ", 1, 11.00, "2026-06-10T15:00:00+00:00", 6),
        _fill("Sell to Open", cc, "XYZ", 1, 0.80, "2026-02-02T15:00:00+00:00", 7),
        {**_fill("Buy to Close", cc, "XYZ", 1, 0.0, "2026-03-20T21:00:00+00:00", None), "transaction-type": "Receive Deliver"},
        _fill("Sell to Open", still_open, "XYZ", 1, 1.10, "2026-03-02T15:00:00+00:00", 8),
    ]
    by = {p["strategy"]: p for p in positions_from_transactions(tx)}
    assert set(by) == {"LEAP", "covered call"}
    assert by["LEAP"]["realized_pnl"] == 200.0 and by["LEAP"]["capital_deployed"] == 900.0
    assert by["covered call"]["realized_pnl"] == 80.0  # expired worthless via Receive Deliver


def test_monthly_rollup_win_rate_and_cumulative():
    positions = [
        {"month": "2026-01", "strategy": "CSP", "realized_pnl": 100.0, "capital_deployed": 5_000.0},
        {"month": "2026-01", "strategy": "CSP", "realized_pnl": -50.0, "capital_deployed": 5_000.0},
        {"month": "2026-02", "strategy": "spread", "realized_pnl": 40.0, "capital_deployed": 400.0},
    ]
    jan, feb = monthly_realized(positions)
    assert (jan["trades"], jan["wins"], jan["win_rate_pct"]) == (2, 1, 50.0)
    assert jan["ror_pct"] == 0.5          # 50 / 10,000
    assert feb["ror_pct"] == 10.0
    assert feb["cumulative_pnl"] == 90.0
    assert feb["cumulative_ror_pct"] == pytest.approx(round((1.005 * 1.10 - 1) * 100, 2))
    strat = {s["strategy"]: s for s in realized_by_strategy(positions)}
    assert strat["CSP"]["realized_pnl"] == 50.0 and strat["spread"]["ror_pct"] == 10.0


# ---------------- versus index ----------------
def test_index_comparison_math():
    days = [D(2026, 1, 29), D(2026, 1, 30), D(2026, 2, 2)]
    values = list(zip(days, [100.0, 110.0, 121.0]))
    spy = list(zip(days, [50.0, 50.0, 55.0]))
    out = compare_to_benchmarks(values, [], {"SPY": spy})
    assert out["cumulative_pct"] == {"Portfolio (TWR)": 21.0, "SPY": 10.0}
    assert out["excess_pct"] == {"SPY": 11.0}
    assert out["growth"]["Portfolio (TWR)"][-1][1] == pytest.approx(12_100)
    assert out["growth"]["SPY"][-1][1] == pytest.approx(11_000)
    jan, feb = out["monthly"]
    assert (jan["portfolio_pct"], jan["SPY_pct"], jan["excess_vs_SPY_pct"]) == (10.0, 0.0, 10.0)
    assert (feb["portfolio_pct"], feb["SPY_pct"], feb["excess_vs_SPY_pct"]) == (10.0, 10.0, 0.0)


def test_index_comparison_uses_twr_not_account_growth():
    days = [D(2026, 1, 2), D(2026, 1, 5)]
    values = list(zip(days, [10_000.0, 20_000.0]))  # all of it is a deposit
    out = compare_to_benchmarks(values, [(days[1], 10_000.0)], {"SPY": list(zip(days, [100.0, 101.0]))})
    assert out["cumulative_pct"]["Portfolio (TWR)"] == 0.0
    assert out["excess_pct"]["SPY"] == -1.0


def test_monthly_index_returns_and_growth_of():
    levels = [(D(2026, 1, 30), 100.0), (D(2026, 2, 27), 105.0), (D(2026, 3, 31), 99.75)]
    m = monthly_index_returns(levels)
    assert m["2026-02"] == pytest.approx(0.05) and m["2026-03"] == pytest.approx(-0.05)
    assert growth_of([(D(2026, 2, 27), 0.05)], 10_000)[-1][1] == pytest.approx(10_500)


def test_fetch_yahoo_parses_adjclose_without_network():
    payload = {"chart": {"result": [{"timestamp": [1767364200, 1767623400, 1767709800],
                                     "indicators": {"adjclose": [{"adjclose": [100.0, None, 101.5]}]}}]}}

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    seen = {}

    def opener(req, timeout):
        seen["url"] = req.full_url
        return Resp(json.dumps(payload).encode())

    rows = fetch_yahoo_total_return("SPY", "1y", opener=opener)
    assert "SPY" in seen["url"]
    assert [v for _, v in rows] == [100.0, 101.5]


# ---------------- SDK adapters + MCP tools ----------------
def _sdk_tx(**kw):
    base = dict(transaction_type="Trade", transaction_sub_type=None, action=None, symbol="", underlying_symbol="",
                instrument_type="Equity Option", quantity=Decimal("1"), price=Decimal("0"), value=Decimal("0"),
                net_value=Decimal("0"), executed_at=datetime(2026, 1, 5, 15), order_id=None)
    base.update(kw)
    return SimpleNamespace(**base)


SDK_HISTORY = [
    _sdk_tx(action=SimpleNamespace(value="Sell to Open"), symbol="XYZ   260320P00050000", underlying_symbol="XYZ",
            price=Decimal("1.00"), value=Decimal("100"), net_value=Decimal("98.86"), executed_at=datetime(2026, 2, 2, 15), order_id=1),
    _sdk_tx(action="Buy to Close", symbol="XYZ   260320P00050000", underlying_symbol="XYZ", price=Decimal("0.40"),
            value=Decimal("-40"), net_value=Decimal("-40.14"), executed_at=datetime(2026, 2, 20, 15), order_id=2),
    _sdk_tx(transaction_type="Money Movement", transaction_sub_type="Deposit", net_value=Decimal("2500"),
            executed_at=datetime(2026, 1, 6, 12)),
    _sdk_tx(transaction_type="Money Movement", transaction_sub_type="Withdrawal", net_value=Decimal("-500"),
            executed_at=datetime(2026, 1, 7, 12)),
    _sdk_tx(transaction_type="Money Movement", transaction_sub_type="Credit Interest", net_value=Decimal("3.10")),
]


def test_adapters_map_signed_sdk_values():
    rest = live.transactions_to_rest(SDK_HISTORY)
    assert [(r["action"], r["net-value"], r["net-value-effect"]) for r in rest] == [
        ("Sell to Open", "98.86", "Credit"),
        ("Buy to Close", "40.14", "Debit"),
    ]
    [p] = positions_from_transactions(rest)
    assert p["strategy"] == "CSP" and p["realized_pnl"] == 58.72
    assert live.transactions_to_flows(SDK_HISTORY) == [(D(2026, 1, 6), 2500.0), (D(2026, 1, 7), -500.0)]


def test_net_liq_history_keeps_last_close_per_day():
    rows = [SimpleNamespace(time="2026-01-05T15:00:00Z", close="100"),
            SimpleNamespace(time="2026-01-05T21:00:00Z", close="101"),
            SimpleNamespace(time="2026-01-06T21:00:00Z", close="0"),
            SimpleNamespace(time="2026-01-07T21:00:00Z", close="103")]
    assert live.net_liq_to_values(rows) == [(D(2026, 1, 5), 101.0), (D(2026, 1, 7), 103.0)]


class _FakeAccount:
    async def get_history(self, session, start_date=None, end_date=None):
        return SDK_HISTORY

    async def get_net_liquidating_value_history(self, session, time_back="1y"):
        return [SimpleNamespace(time="2026-01-05T21:00:00Z", close="10000"),
                SimpleNamespace(time="2026-01-06T21:00:00Z", close="12600"),
                SimpleNamespace(time="2026-01-07T21:00:00Z", close="12100")]


def test_mcp_performance_tools_are_read_only_and_offline(monkeypatch):
    import server

    async def fake_ctx():
        return None, _FakeAccount()

    def no_network(sym, range_):
        raise OSError("offline")

    monkeypatch.setattr(server, "_ctx", fake_ctx)
    monkeypatch.setattr(server, "fetch_yahoo_total_return", no_network)

    monthly = asyncio.run(server.get_monthly_returns("2026-01-01", "2026-03-31"))
    assert monthly["monthly"][0]["realized_pnl"] == 58.72
    assert monthly["by_strategy"][0]["strategy"] == "CSP"

    perf = asyncio.run(server.get_twr_vs_index())
    # +2,500 deposit on day 2 (100 of market gain), -500 withdrawal on day 3 (flat).
    assert perf["twr_pct"] == pytest.approx(1.0)
    assert perf["net_contributions"] == 2000.0 and perf["market_gain"] == 100.0
    assert set(perf["benchmarks_unavailable"]) == {"SPY", "QQQ"}


def test_demo_cli_writes_report(tmp_path, capsys):
    from performance.__main__ import main

    assert main(["--demo", "--out", str(tmp_path), "--no-charts"]) == 0
    text = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert "SYNTHETIC DEMO DATA" in text and "Time-weighted return" in text
    for name in ("monthly_realized.csv", "realized_by_strategy.csv", "monthly_vs_index.csv", "contributions_vs_gains.csv"):
        assert (tmp_path / name).exists()
    assert "time-weighted" in capsys.readouterr().out
