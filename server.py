"""Tastytrade MCP server.

Read-only tools are open. Both write tools (place_order, place_option_order) are
gated behind safety.safe_place: they dry-run first and refuse to go live unless
LIVE_TRADING_ENABLED=true AND MCP_AUTH_TOKEN is set AND confirm='CONFIRM'.

Run locally (stdio) for first tests:
    py server.py

Going remote: use the Cloudflare Worker in worker/ instead. It speaks the same
tool contract over streamable-HTTP with bearer-token auth in front of it.

Order actions accepted everywhere: BUY_TO_OPEN, SELL_TO_OPEN, BUY_TO_CLOSE,
SELL_TO_CLOSE. Always pass a POSITIVE limit_price; debit/credit sign is derived
from the action.
"""
from __future__ import annotations

import asyncio
from datetime import date, timedelta

from mcp.server.fastmcp import FastMCP

from auth import get_account, get_session
from market import get_quote as _get_quote
from orders import (
    build_equity_order,
    build_option_order,
    list_expirations as _list_exps,
    list_strikes as _list_strikes,
)
from performance import live as perf_live
from performance.benchmark import compare_to_benchmarks, fetch_yahoo_total_return
from performance.realized import monthly_realized, positions_from_transactions, realized_by_strategy
from performance.returns import contributions_vs_gains, monthly_modified_dietz, twr
from safety import safe_place
from scanner import scan_symbols as _scan_syms
from scanner import scan_watchlist as _scan_wl
from watchlists import get_watchlist_symbols, list_watchlists as _list_wls

mcp = FastMCP("tastytrade")


async def _ctx():
    session = get_session()
    account = await get_account(session)
    return session, account


# ---------------- read-only ----------------
@mcp.tool()
async def get_balances() -> dict:
    """Account balances and buying power."""
    session, account = await _ctx()
    b = await account.get_balances(session)
    return {
        "net_liq": str(getattr(b, "net_liquidating_value", None)),
        "cash": str(getattr(b, "cash_balance", None)),
        "derivative_buying_power": str(getattr(b, "derivative_buying_power", None)),
    }


@mcp.tool()
async def get_positions() -> list[dict]:
    """Open positions."""
    session, account = await _ctx()
    positions = await account.get_positions(session)
    return [
        {
            "symbol": p.symbol,
            "quantity": str(p.quantity),
            "type": str(getattr(p, "instrument_type", None)),
        }
        for p in positions
    ]


@mcp.tool()
async def get_quote(symbol: str) -> dict:
    """Live bid/ask for a symbol."""
    session, _ = await _ctx()
    return await _get_quote(session, symbol)


@mcp.tool()
async def list_watchlists() -> list[dict]:
    """Your watchlists with symbol counts."""
    session, _ = await _ctx()
    return await _list_wls(session)


@mcp.tool()
async def scan_watchlist(name: str, min_iv_rank: float = 50.0) -> list[dict]:
    """Scan a watchlist for symbols with IV rank >= min_iv_rank (0-100)."""
    session, _ = await _ctx()
    return await _scan_wl(session, name, min_iv_rank)


@mcp.tool()
async def scan_symbols(symbols: list[str], min_iv_rank: float = 50.0) -> list[dict]:
    """Scan an arbitrary symbol list for IV rank >= min_iv_rank (0-100)."""
    session, _ = await _ctx()
    return await _scan_syms(session, symbols, min_iv_rank)


# ---------------- options discovery (read-only) ----------------
@mcp.tool()
async def get_option_expirations(underlying: str) -> list[str]:
    """List available option expiration dates (YYYY-MM-DD) for an underlying."""
    session, _ = await _ctx()
    return await _list_exps(session, underlying)


@mcp.tool()
async def get_option_strikes(underlying: str, expiration: str) -> list[dict]:
    """List strikes for an underlying + expiration, with call/put availability."""
    session, _ = await _ctx()
    return await _list_strikes(session, underlying, expiration)


# ---------------- equity orders ----------------
@mcp.tool()
async def preview_order(
    symbol: str, quantity: int, limit_price: float, action: str = "BUY_TO_OPEN"
) -> dict:
    """DRY-RUN a stock limit order. Returns buying-power effect + fees. Places nothing."""
    session, account = await _ctx()
    order = await build_equity_order(session, symbol, quantity, limit_price, action)
    return await safe_place(account, session, order)


@mcp.tool()
async def place_order(
    symbol: str,
    quantity: int,
    limit_price: float,
    action: str = "BUY_TO_OPEN",
    confirm: str = "",
) -> dict:
    """Place a REAL stock limit order.

    Requires LIVE_TRADING_ENABLED=true, MCP_AUTH_TOKEN set, AND confirm='CONFIRM'. Otherwise returns a
    dry-run summary (status DRY_RUN_ONLY or NEEDS_CONFIRMATION).
    """
    session, account = await _ctx()
    order = await build_equity_order(session, symbol, quantity, limit_price, action)
    return await safe_place(account, session, order, confirm=confirm)


# ---------------- option orders ----------------
@mcp.tool()
async def preview_option_order(
    underlying: str,
    expiration: str,
    strike: float,
    option_type: str,
    quantity: int,
    limit_price: float,
    action: str = "BUY_TO_OPEN",
) -> dict:
    """DRY-RUN a single-leg option order. Places nothing.

    option_type: C/CALL or P/PUT. expiration: YYYY-MM-DD. limit_price: positive
    premium per contract (sign derived from action).
    """
    session, account = await _ctx()
    order = await build_option_order(
        session, underlying, expiration, strike, option_type, quantity, limit_price, action
    )
    return await safe_place(account, session, order)


@mcp.tool()
async def place_option_order(
    underlying: str,
    expiration: str,
    strike: float,
    option_type: str,
    quantity: int,
    limit_price: float,
    action: str = "BUY_TO_OPEN",
    confirm: str = "",
) -> dict:
    """Place a REAL single-leg option order.

    Requires LIVE_TRADING_ENABLED=true, MCP_AUTH_TOKEN set, AND confirm='CONFIRM'. Otherwise returns a
    dry-run summary. option_type: C/CALL or P/PUT. expiration: YYYY-MM-DD.
    """
    session, account = await _ctx()
    order = await build_option_order(
        session, underlying, expiration, strike, option_type, quantity, limit_price, action
    )
    return await safe_place(account, session, order, confirm=confirm)


# ---------------- performance (read-only) ----------------
def _parse_day(s: str, default: date) -> date:
    return date.fromisoformat(s) if s else default


@mcp.tool()
async def get_monthly_returns(start_date: str = "", end_date: str = "") -> dict:
    """Realized P&L by close month with return on capital deployed, win rate,
    cumulative P&L, and a by-strategy rollup (CSP / covered call / spread /
    LEAP / stock). Dates YYYY-MM-DD; default is the last 365 days. Read-only."""
    session, account = await _ctx()
    end = _parse_day(end_date, date.today())
    start = _parse_day(start_date, end - timedelta(days=365))
    txns = await account.get_history(session, start_date=start, end_date=end)
    positions = positions_from_transactions(perf_live.transactions_to_rest(txns))
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "monthly": monthly_realized(positions),
        "by_strategy": realized_by_strategy(positions),
    }


@mcp.tool()
async def get_twr_vs_index(time_back: str = "1y", benchmarks: list[str] | None = None) -> dict:
    """Time-weighted return with deposits and withdrawals backed out, monthly
    TWR and Modified Dietz, net deposits vs market gain, and comparison with
    index total return (dividend-adjusted closes, default SPY and QQQ).
    time_back: 1m, 3m, 6m, 1y or all. Read-only."""
    session, account = await _ctx()
    rows = await account.get_net_liquidating_value_history(session, time_back=time_back)
    values = perf_live.net_liq_to_values(rows)
    if len(values) < 2:
        return {"error": "not enough net-liq history to measure a return"}
    txns = await account.get_history(session, start_date=values[0][0], end_date=values[-1][0])
    flows = perf_live.transactions_to_flows(txns)
    index, unavailable = {}, {}
    for sym in benchmarks or ["SPY", "QQQ"]:
        try:  # index data is optional context; stdout is the MCP channel, so no prints
            series = await asyncio.to_thread(fetch_yahoo_total_return, sym, "2y")
        except Exception as e:
            unavailable[sym] = str(e)[:200]
            continue
        if len(series) >= 2:
            index[sym] = series
    cmp = compare_to_benchmarks(values, flows, index)
    split = contributions_vs_gains(values, flows)[-1]
    dietz = {r["month"]: r["dietz_pct"] for r in monthly_modified_dietz(values, flows)}
    return {
        "start": cmp["start"],
        "end": cmp["end"],
        "twr_pct": round(twr(values, flows) * 100, 2),
        "naive_growth_pct": round((values[-1][1] / values[0][1] - 1) * 100, 2),
        "net_contributions": split["net_contributions"],
        "market_gain": split["market_gain"],
        "cumulative_pct": cmp["cumulative_pct"],
        "excess_pct": cmp["excess_pct"],
        "monthly": [{**r, "dietz_pct": dietz.get(r["month"])} for r in cmp["monthly"]],
        "benchmarks_unavailable": unavailable,
        "note": "Deposits and withdrawals are excluded from returns. Not investment advice.",
    }


if __name__ == "__main__":
    # Local stdio transport. For remote use, deploy worker/ instead.
    mcp.run()
