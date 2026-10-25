"""Compare the portfolio's time-weighted return with index total return.

Index series are daily total-return levels (price with dividends reinvested),
as ``(date, level)`` pairs. The demo uses a bundled synthetic series. With
network access, ``fetch_yahoo_total_return`` pulls dividend-adjusted closes
from Yahoo's public chart endpoint (unofficial; it can change or rate-limit).
"""
from __future__ import annotations

import json
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone

from .returns import daily_twr, link

YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range}&interval=1d&events=div"


def _month(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def index_daily_returns(levels) -> list[tuple[date, float]]:
    return [(d1, l1 / l0 - 1) for (_, l0), (d1, l1) in zip(levels, levels[1:])]


def monthly_index_returns(levels) -> dict[str, float]:
    by: dict[str, list[float]] = defaultdict(list)
    for d, r in index_daily_returns(levels):
        by[_month(d)].append(r)
    return {m: link(rs) for m, rs in sorted(by.items())}


def growth_of(daily_returns, start: float = 10_000.0, start_date: date | None = None) -> list[tuple[date, float]]:
    """Growth-of-$X path from daily returns."""
    path = [(start_date, start)] if start_date else []
    v = start
    for d, r in daily_returns:
        v *= 1 + r
        path.append((d, v))
    return path


def compare_to_benchmarks(values, flows, benchmarks: dict[str, list], start: float = 10_000.0) -> dict:
    """TWR vs each benchmark over the same dates.

    Returns cumulative returns, a growth-of-$10k path per series, and a monthly
    table with the portfolio's excess return over each benchmark.
    """
    port_daily = daily_twr(values, flows)
    first = values[0][0]
    window = {d for d, _ in values}

    def clip(levels):
        return [(d, l) for d, l in levels if d in window]

    series = {"Portfolio (TWR)": port_daily}
    for name, levels in benchmarks.items():
        series[name] = index_daily_returns(clip(levels))

    cumulative = {name: link(r for _, r in rs) for name, rs in series.items()}
    growth = {name: growth_of(rs, start, first) for name, rs in series.items()}

    monthly: dict[str, dict] = defaultdict(dict)
    for name, rs in series.items():
        by: dict[str, list[float]] = defaultdict(list)
        for d, r in rs:
            by[_month(d)].append(r)
        for m, chunk in by.items():
            monthly[m][name] = link(chunk)
    table = []
    for m in sorted(monthly):
        row = {"month": m, "portfolio_pct": round(monthly[m]["Portfolio (TWR)"] * 100, 2)}
        for name in benchmarks:
            b = monthly[m].get(name)
            row[f"{name}_pct"] = round(b * 100, 2) if b is not None else None
            row[f"excess_vs_{name}_pct"] = (
                round((monthly[m]["Portfolio (TWR)"] - b) * 100, 2) if b is not None else None
            )
        table.append(row)

    return {
        "start": first.isoformat(),
        "end": values[-1][0].isoformat(),
        "cumulative_pct": {k: round(v * 100, 2) for k, v in cumulative.items()},
        "excess_pct": {k: round((cumulative["Portfolio (TWR)"] - v) * 100, 2) for k, v in cumulative.items() if k in benchmarks},
        "growth": growth,
        "monthly": table,
    }


def fetch_yahoo_total_return(symbol: str, range_: str = "1y", opener=urllib.request.urlopen) -> list[tuple[date, float]]:
    """Dividend-adjusted daily closes for ``symbol`` (network; not used in demo)."""
    req = urllib.request.Request(
        YAHOO_CHART.format(symbol=symbol, range=range_),
        headers={"User-Agent": "Mozilla/5.0 (tastytrade-mcp performance)"},
    )
    with opener(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    result = payload["chart"]["result"][0]
    stamps = result["timestamp"]
    adj = result["indicators"]["adjclose"][0]["adjclose"]
    out = []
    for ts, px in zip(stamps, adj):
        if px is None:
            continue
        out.append((datetime.fromtimestamp(ts, tz=timezone.utc).date(), float(px)))
    return out
