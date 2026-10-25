"""Realized P&L by month and by strategy, with return on capital deployed.

Input is Tastytrade transaction history in the REST shape (the same dicts the
Worker's ``get_transaction_history`` returns and ``worker/fixtures`` holds):
``action``, ``symbol``, ``underlying-symbol``, ``instrument-type``,
``quantity``, ``price``, ``net-value``, ``net-value-effect``, ``executed-at``,
``order-id``.

Steps:
1. ``match_realized`` pairs opening and closing fills per symbol, fees included.
   It is a port of the Worker's ``matchRealizedPnl``: only fully closed symbols
   count, so open positions never leak into realized numbers.
2. ``positions_from_transactions`` groups closed legs that were opened in the
   same order into one position and labels the strategy.
3. ``monthly_realized`` / ``realized_by_strategy`` roll positions up.

Capital deployed (the RoR denominator) per strategy:
- CSP: strike x 100 x contracts (the cash that secures the put).
- Covered call: strike x 100 x contracts (the shares committed, valued at the
  strike; share cost basis is not in the option fills).
- Spread: for a credit spread, max loss = widest same-type strike width x 100 x
  contracts - credit received. For a debit spread or calendar, the debit paid.
- LEAP / long option / stock: the opening debit.
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime

OCC = re.compile(r"^(?P<root>[A-Z.]+)\s*(?P<yymmdd>\d{6})(?P<right>[CP])(?P<strike>\d{8})$")

STRATEGIES = ("CSP", "covered call", "spread", "LEAP", "long option", "stock")


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _signed_net(t: dict) -> float:
    """Cash effect of a fill, fees included: credits positive, debits negative."""
    v = _num(t.get("net-value"))
    return v if t.get("net-value-effect") == "Credit" else -v


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def parse_occ(symbol: str) -> dict | None:
    m = OCC.match(symbol.strip())
    if not m:
        return None
    y, mo, d = m.group("yymmdd")[:2], m.group("yymmdd")[2:4], m.group("yymmdd")[4:]
    return {
        "root": m.group("root"),
        "expiration": date(2000 + int(y), int(mo), int(d)),
        "right": m.group("right"),
        "strike": int(m.group("strike")) / 1000,
    }


def match_realized(items: list[dict]) -> list[dict]:
    """Closed legs, one row per fully closed symbol. Mirrors matchRealizedPnl."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for t in items:
        # Expirations and assignments arrive as "Receive Deliver" rows with a
        # closing action; they close a position just like a trade does.
        if t.get("transaction-type", "Trade") in ("Trade", "Receive Deliver") and t.get("action"):
            groups[t["symbol"]].append(t)

    closed = []
    for sym, fills in groups.items():
        open_qty = close_qty = open_cash = close_cash = 0.0
        first_open = last_close = None
        open_order = open_action = None
        underlying = itype = None
        for t in sorted(fills, key=lambda f: f["executed-at"]):
            qty = _num(t.get("quantity"))
            underlying = t.get("underlying-symbol")
            itype = t.get("instrument-type")
            if "Open" in t["action"]:
                open_qty += qty
                open_cash += _signed_net(t)
                if first_open is None:
                    first_open, open_order, open_action = t["executed-at"], t.get("order-id"), t["action"]
            elif "Close" in t["action"]:
                close_qty += qty
                close_cash += _signed_net(t)
                last_close = t["executed-at"]
        if open_qty > 0 and close_qty >= open_qty:
            closed.append(
                {
                    "symbol": sym,
                    "underlying": underlying,
                    "type": itype,
                    "quantity": open_qty,
                    "open_action": open_action,
                    "open_order_id": open_order,
                    "opened_at": first_open,
                    "closed_at": last_close,
                    "open_cash": round(open_cash, 2),
                    "realized_pnl": round(open_cash + close_cash, 2),
                }
            )
    return closed


def _classify(legs: list[dict]) -> str:
    options = [l for l in legs if l["type"] == "Equity Option"]
    if len(options) >= 2:
        return "spread"
    if not options:
        return "stock"
    leg = options[0]
    occ = parse_occ(leg["symbol"])
    if leg["open_action"].startswith("Sell"):
        return "CSP" if occ and occ["right"] == "P" else "covered call"
    if occ and (occ["expiration"] - _ts(leg["opened_at"]).date()).days >= 365:
        return "LEAP"
    return "long option"


def _capital(strategy: str, legs: list[dict]) -> float:
    open_cash = sum(l["open_cash"] for l in legs)
    if strategy in ("CSP", "covered call"):
        occ = parse_occ(legs[0]["symbol"])
        return occ["strike"] * 100 * legs[0]["quantity"]
    if strategy == "spread":
        if open_cash <= 0:  # debit spread or calendar: you can lose what you paid
            return -open_cash
        widths = []
        for right in ("P", "C"):
            strikes = [parse_occ(l["symbol"])["strike"] for l in legs if parse_occ(l["symbol"])["right"] == right]
            if len(strikes) >= 2:
                widths.append(max(strikes) - min(strikes))
        contracts = min(l["quantity"] for l in legs)
        return max(max(widths, default=0) * 100 * contracts - open_cash, 0.0)
    return -open_cash  # long premium or shares: the opening debit


def positions_from_transactions(items: list[dict]) -> list[dict]:
    """Closed positions with strategy, capital deployed and RoR."""
    by_order: dict[object, list[dict]] = defaultdict(list)
    for leg in match_realized(items):
        by_order[leg["open_order_id"] or leg["symbol"]].append(leg)

    positions = []
    for order_id, legs in by_order.items():
        strategy = _classify(legs)
        capital = round(_capital(strategy, legs), 2)
        pnl = round(sum(l["realized_pnl"] for l in legs), 2)
        closed_at = max(l["closed_at"] for l in legs)
        positions.append(
            {
                "underlying": legs[0]["underlying"],
                "strategy": strategy,
                "legs": len(legs),
                "opened_at": min(l["opened_at"] for l in legs),
                "closed_at": closed_at,
                "month": closed_at[:7],
                "realized_pnl": pnl,
                "capital_deployed": capital,
                "ror_pct": round(pnl / capital * 100, 2) if capital > 0 else None,
            }
        )
    positions.sort(key=lambda p: p["closed_at"])
    return positions


def _rollup(rows: list[dict]) -> dict:
    pnl = round(sum(p["realized_pnl"] for p in rows), 2)
    capital = round(sum(p["capital_deployed"] for p in rows), 2)
    wins = sum(1 for p in rows if p["realized_pnl"] > 0)
    return {
        "trades": len(rows),
        "wins": wins,
        "win_rate_pct": round(wins / len(rows) * 100, 1) if rows else None,
        "realized_pnl": pnl,
        "capital_deployed": capital,
        "ror_pct": round(pnl / capital * 100, 2) if capital > 0 else None,
    }


def monthly_realized(positions: list[dict]) -> list[dict]:
    """One row per close month: realized P&L, RoR on capital deployed, win rate,
    cumulative P&L, and a compounded cumulative RoR."""
    by_month: dict[str, list[dict]] = defaultdict(list)
    for p in positions:
        by_month[p["month"]].append(p)
    out, cum_pnl, growth = [], 0.0, 1.0
    for month in sorted(by_month):
        row = {"month": month, **_rollup(by_month[month])}
        cum_pnl += row["realized_pnl"]
        if row["ror_pct"] is not None:
            growth *= 1 + row["ror_pct"] / 100
        row["cumulative_pnl"] = round(cum_pnl, 2)
        row["cumulative_ror_pct"] = round((growth - 1) * 100, 2)
        out.append(row)
    return out


def realized_by_strategy(positions: list[dict]) -> list[dict]:
    by: dict[str, list[dict]] = defaultdict(list)
    for p in positions:
        by[p["strategy"]].append(p)
    return [{"strategy": s, **_rollup(by[s])} for s in STRATEGIES if s in by]
