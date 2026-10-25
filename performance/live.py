"""Adapters from tastytrade SDK objects to the plain shapes the engine uses.

Written defensively against the SDK's Transaction and net-liq history models
(attribute names in snake_case, enums or plain strings, signed or unsigned
Decimals). The offline tests feed these fakes; check the output once against
your own account before trusting it.
"""
from __future__ import annotations

from datetime import date, datetime

DEPOSIT_SUBTYPES = {"Deposit", "Withdrawal", "ACH Deposit", "ACH Withdrawal", "Wire Funds Received", "Wire Funds Sent"}


def _s(v) -> str:
    """Enum or string -> string."""
    return "" if v is None else str(getattr(v, "value", v))


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _iso(v) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _effect(obj, field: str) -> tuple[float, str]:
    """(absolute amount, 'Credit'|'Debit') whether the SDK gives an explicit
    effect field or a signed number."""
    raw = _f(getattr(obj, field, 0))
    eff = _s(getattr(obj, f"{field}_effect", None))
    if eff in ("Credit", "Debit"):
        return abs(raw), eff
    return abs(raw), "Credit" if raw >= 0 else "Debit"


def transactions_to_rest(txns) -> list[dict]:
    """SDK Transaction objects -> REST-shaped dicts for performance.realized."""
    out = []
    for t in txns:
        ttype = _s(getattr(t, "transaction_type", ""))
        action = _s(getattr(t, "action", ""))
        if ttype not in ("Trade", "Receive Deliver") or not action:
            continue
        net, net_eff = _effect(t, "net_value")
        val, val_eff = _effect(t, "value")
        out.append(
            {
                "transaction-type": "Trade",
                "action": action,
                "symbol": _s(getattr(t, "symbol", "")),
                "underlying-symbol": _s(getattr(t, "underlying_symbol", "")),
                "instrument-type": _s(getattr(t, "instrument_type", "")),
                "quantity": str(_f(getattr(t, "quantity", 0))),
                "price": str(_f(getattr(t, "price", 0))),
                "value": f"{val:.2f}",
                "value-effect": val_eff,
                "net-value": f"{net:.2f}",
                "net-value-effect": net_eff,
                "executed-at": _iso(getattr(t, "executed_at", "")),
                "order-id": getattr(t, "order_id", None),
            }
        )
    return out


def transactions_to_flows(txns) -> list[tuple[date, float]]:
    """Deposits and withdrawals only. Trades, fees, interest and dividends are
    returns, not flows."""
    flows = []
    for t in txns:
        if _s(getattr(t, "transaction_type", "")) != "Money Movement":
            continue
        if _s(getattr(t, "transaction_sub_type", "")) not in DEPOSIT_SUBTYPES:
            continue
        amt, eff = _effect(t, "net_value")
        when = getattr(t, "executed_at", None) or getattr(t, "transaction_date", None)
        d = when.date() if isinstance(when, datetime) else date.fromisoformat(str(when)[:10])
        flows.append((d, amt if eff == "Credit" else -amt))
    return sorted(flows)


def net_liq_to_values(rows) -> list[tuple[date, float]]:
    """Net-liq history rows (``time`` + ``close``) -> one end-of-day value per date."""
    by_day: dict[date, tuple[str, float]] = {}
    for r in rows:
        stamp = _iso(getattr(r, "time", ""))
        d = date.fromisoformat(stamp[:10])
        close = _f(getattr(r, "close", None))
        if close <= 0:
            continue
        if d not in by_day or stamp >= by_day[d][0]:
            by_day[d] = (stamp, close)
    return [(d, v) for d, (_, v) in sorted(by_day.items())]
