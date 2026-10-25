"""Market scanning.

IMPORTANT: Tastytrade has NO server-side screener. You cannot ask it to
discover symbols across the whole market. You supply a universe of symbols
(e.g. a watchlist, or an index constituent list you bring yourself) and filter
locally on the market-metrics data.

VERIFY ON FIRST RUN: the IV-rank attribute name on the metric object. It is a
0..1 decimal (0.42 == 42%). _iv_rank() tries a few candidate names; if scans
always come back empty, print one metric object and pin the real attribute.
"""
from __future__ import annotations

from tastytrade.metrics import get_market_metrics

from watchlists import get_watchlist_symbols


def _iv_rank(m) -> float | None:
    for attr in (
        "implied_volatility_index_rank",
        "tos_implied_volatility_index_rank",
        "iv_rank",
    ):
        v = getattr(m, attr, None)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return None


async def scan_symbols(session, symbols: list[str], min_iv_rank: float = 0.0) -> list[dict]:
    """Return symbols whose IV rank (0-100) is >= min_iv_rank, highest first."""
    if not symbols:
        return []
    metrics = await get_market_metrics(session, symbols)
    rows: list[dict] = []
    for m in metrics:
        ivr = _iv_rank(m)
        if ivr is None:
            continue
        ivr_pct = round(ivr * 100, 1)
        if ivr_pct >= min_iv_rank:
            rows.append(
                {
                    "symbol": getattr(m, "symbol", None),
                    "iv_rank": ivr_pct,
                    "liquidity": getattr(m, "liquidity_rating", None),
                    "beta": str(getattr(m, "beta", None)),
                }
            )
    return sorted(rows, key=lambda r: r["iv_rank"], reverse=True)


async def scan_watchlist(session, name: str, min_iv_rank: float = 0.0) -> list[dict]:
    symbols = await get_watchlist_symbols(session, name)
    return await scan_symbols(session, symbols, min_iv_rank)
