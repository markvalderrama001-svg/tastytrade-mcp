"""Command line: ``py -m performance --demo`` or point it at your own files.

    py -m performance --demo
    py -m performance --values values.csv --flows flows.csv --transactions tx.json
                      [--benchmark SPY=spy.csv --benchmark QQQ=qqq.csv | --fetch-index SPY QQQ]

values.csv: date,value (end-of-day account value)
flows.csv:  date,amount (deposits positive, withdrawals negative)
spy.csv:    date,level (total-return level, e.g. dividend-adjusted close)
tx.json:    Tastytrade transaction history ({"data": {"items": [...]}} or a list)
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path

from . import report as rpt
from .benchmark import fetch_yahoo_total_return

ROOT = Path(__file__).resolve().parents[1]


def _read_pairs(path: str) -> list[tuple[date, float]]:
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    return [(date.fromisoformat(r[0]), float(r[1])) for r in rows[1:] if r]


def _read_tx(path: str) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["data"]["items"] if isinstance(data, dict) else data


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="py -m performance", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="use bundled synthetic data (offline)")
    ap.add_argument("--values")
    ap.add_argument("--flows")
    ap.add_argument("--transactions")
    ap.add_argument("--benchmark", action="append", default=[], metavar="NAME=CSV")
    ap.add_argument("--fetch-index", nargs="*", metavar="SYMBOL", help="download dividend-adjusted closes (network)")
    ap.add_argument("--out", default=None, help="report folder (default docs/performance for --demo, output/performance otherwise)")
    ap.add_argument("--charts", default=None, help="PNG folder (default docs for --demo, same as --out otherwise)")
    ap.add_argument("--no-charts", action="store_true")
    a = ap.parse_args(argv)

    if a.demo:
        from .synthetic import demo_series, demo_transactions

        values, flows, benchmarks = demo_series()
        transactions = demo_transactions()
        out = Path(a.out or ROOT / "docs" / "performance")
        charts = Path(a.charts or ROOT / "docs")
    else:
        if not (a.values and a.transactions):
            ap.error("pass --demo, or at least --values and --transactions")
        values = _read_pairs(a.values)
        flows = _read_pairs(a.flows) if a.flows else []
        transactions = _read_tx(a.transactions)
        benchmarks = {}
        for spec in a.benchmark:
            name, _, path = spec.partition("=")
            benchmarks[name] = _read_pairs(path)
        for sym in a.fetch_index or []:
            benchmarks[sym] = fetch_yahoo_total_return(sym)
        out = Path(a.out or ROOT / "output" / "performance")
        charts = Path(a.charts or out)

    r = rpt.build(values, flows, benchmarks, transactions)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.md").write_text(rpt.to_markdown(r, synthetic=a.demo), encoding="utf-8", newline="\n")
    rpt.write_csv(out / "monthly_realized.csv", r["monthly_realized"])
    rpt.write_csv(out / "realized_by_strategy.csv", r["by_strategy"])
    rpt.write_csv(out / "monthly_vs_index.csv", r["benchmark"]["monthly"])
    rpt.write_csv(out / "contributions_vs_gains.csv", r["split"])

    b = r["benchmark"]
    end = r["split"][-1]
    print(f"Period {b['start']} to {b['end']}{'  (SYNTHETIC DEMO DATA)' if a.demo else ''}")
    print(f"  account value      {end['starting_capital']:>12,.2f} -> {end['value']:,.2f}")
    print(f"  net deposits       {end['net_contributions']:>12,.2f}")
    print(f"  market gain        {end['market_gain']:>12,.2f}")
    print(f"  naive growth       {r['naive_growth_pct']:>+11.2f}%   (deposits counted as gains: wrong)")
    print(f"  time-weighted      {r['twr_pct']:>+11.2f}%")
    for name, pct in b["cumulative_pct"].items():
        if name != "Portfolio (TWR)":
            print(f"  {name:<6} total ret   {pct:>+11.2f}%   portfolio excess {b['excess_pct'][name]:+.2f} pts")
    last = r["monthly_realized"]
    wins = sum(m["wins"] for m in last)
    trades = sum(m["trades"] for m in last)
    print(f"  realized P&L       {last[-1]['cumulative_pnl']:>12,.2f}   over {trades} closed positions, win rate {wins / trades * 100:.0f}%")
    print(f"report  -> {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")

    if not a.no_charts:
        try:
            from . import charts as ch
        except ImportError:
            print("charts skipped: matplotlib not installed (pip install -r requirements-dev.txt)")
            return 0
        note = "Synthetic demo data. Not investment advice." if a.demo else "Not investment advice."
        charts.mkdir(parents=True, exist_ok=True)
        made = [
            ch.growth_vs_index(r, charts / "perf-growth-vs-index.png", note),
            ch.monthly_realized(r, charts / "perf-monthly-realized.png", note),
            ch.contributions_vs_gains(r, charts / "perf-contributions-vs-gains.png", note),
        ]
        for p in made:
            print(f"chart   -> {p.relative_to(ROOT) if p.is_relative_to(ROOT) else p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
