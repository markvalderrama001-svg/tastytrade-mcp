"""Portfolio return that ignores deposits and withdrawals.

A deposit makes the account bigger. It isn't a return. These functions take a
series of end-of-day account values plus the external cash flows, and back the
flows out before measuring growth.

Conventions (used everywhere in this module):
- ``values`` is a list of ``(date, value)`` end-of-day account values, sorted.
- ``flows`` is a list of ``(date, amount)`` external cash flows: deposits
  positive, withdrawals negative. Trades, fees and dividends are NOT flows; they
  are part of the return.
- A flow on day t is assumed to arrive at the close of day t, so it is already
  inside V_t. The day's return is then r_t = (V_t - F_t) / V_{t-1} - 1.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date


def _flow_map(flows) -> dict[date, float]:
    m: dict[date, float] = defaultdict(float)
    for d, amt in flows:
        m[d] += amt
    return m


def daily_twr(values, flows=()) -> list[tuple[date, float]]:
    """Daily sub-period returns, each one cleaned of that day's flow."""
    fm = _flow_map(flows)
    out = []
    for (d0, v0), (d1, v1) in zip(values, values[1:]):
        if v0 <= 0:
            raise ValueError(f"account value must be positive on {d0}")
        out.append((d1, (v1 - fm.get(d1, 0.0)) / v0 - 1))
    return out


def link(returns) -> float:
    """Chain-link a sequence of period returns into one cumulative return."""
    g = 1.0
    for r in returns:
        g *= 1 + r
    return g - 1


def twr(values, flows=()) -> float:
    """Time-weighted return over the whole series."""
    return link(r for _, r in daily_twr(values, flows))


def _month(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def monthly_twr(values, flows=()) -> list[dict]:
    """Daily returns chain-linked within each calendar month."""
    by: dict[str, list[float]] = defaultdict(list)
    for d, r in daily_twr(values, flows):
        by[_month(d)].append(r)
    return [{"month": m, "twr_pct": round(link(rs) * 100, 4)} for m, rs in sorted(by.items())]


def modified_dietz(v_begin: float, v_end: float, begin: date, end: date, flows=()) -> float:
    """Modified Dietz return for one period.

    R = (V_end - V_begin - F) / (V_begin + sum(w_i * F_i)),
    w_i = (D - d_i) / D, D = calendar days in the period, d_i = days from the
    period start to flow i. With end-of-day flows a deposit on the last day gets
    weight 0 and one on the day after the start gets (D - 1) / D.
    """
    days = (end - begin).days
    if days <= 0:
        raise ValueError("period must be at least one day")
    in_period = [(d, a) for d, a in flows if begin < d <= end]
    net = sum(a for _, a in in_period)
    weighted = sum(a * (days - (d - begin).days) / days for d, a in in_period)
    denom = v_begin + weighted
    if denom <= 0:
        raise ValueError("average capital must be positive")
    return (v_end - v_begin - net) / denom


def monthly_modified_dietz(values, flows=()) -> list[dict]:
    """Modified Dietz per calendar month. Each month starts from the prior
    month's last value (the first month starts from the first value)."""
    last_by_month: dict[str, tuple[date, float]] = {}
    for d, v in values:
        last_by_month[_month(d)] = (d, v)
    months = sorted(last_by_month)
    out = []
    prev = values[0]
    for m in months:
        end = last_by_month[m]
        if end[0] <= prev[0]:
            continue
        r = modified_dietz(prev[1], end[1], prev[0], end[0], flows)
        out.append({"month": m, "dietz_pct": round(r * 100, 4)})
        prev = end
    return out


def contributions_vs_gains(values, flows=()) -> list[dict]:
    """Split each day's account value into starting capital, net contributions
    to date, and market gain to date (value - start - contributions)."""
    fm = _flow_map(flows)
    start = values[0][1]
    cum = 0.0
    out = []
    for d, v in values:
        if d != values[0][0]:
            cum += fm.get(d, 0.0)
        out.append(
            {
                "date": d.isoformat(),
                "value": round(v, 2),
                "starting_capital": round(start, 2),
                "net_contributions": round(cum, 2),
                "market_gain": round(v - start - cum, 2),
            }
        )
    return out
