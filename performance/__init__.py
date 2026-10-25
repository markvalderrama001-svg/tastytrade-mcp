"""Performance tracking: realized returns by month, time-weighted return, and
comparison against index total return.

Pure Python, read-only, no network unless you ask for live index data. Charts
need matplotlib (``pip install -r requirements-dev.txt``); the math does not.

    py -m performance --demo        # synthetic data -> docs/performance/
"""
from .benchmark import compare_to_benchmarks, growth_of, monthly_index_returns
from .realized import match_realized, monthly_realized, positions_from_transactions, realized_by_strategy
from .returns import (
    contributions_vs_gains,
    daily_twr,
    modified_dietz,
    monthly_modified_dietz,
    monthly_twr,
    twr,
)

__all__ = [
    "compare_to_benchmarks",
    "contributions_vs_gains",
    "daily_twr",
    "growth_of",
    "match_realized",
    "modified_dietz",
    "monthly_index_returns",
    "monthly_modified_dietz",
    "monthly_realized",
    "monthly_twr",
    "positions_from_transactions",
    "realized_by_strategy",
    "twr",
]
