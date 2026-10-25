"""Build the performance report (dict, Markdown and CSV) from raw inputs."""
from __future__ import annotations

import csv
from pathlib import Path

from .benchmark import compare_to_benchmarks
from .realized import monthly_realized, positions_from_transactions, realized_by_strategy
from .returns import contributions_vs_gains, monthly_modified_dietz, monthly_twr, twr


def build(values, flows, benchmarks, transactions) -> dict:
    positions = positions_from_transactions(transactions)
    split = contributions_vs_gains(values, flows)
    md = {r["month"]: r["dietz_pct"] for r in monthly_modified_dietz(values, flows)}
    return {
        "positions": positions,
        "monthly_realized": monthly_realized(positions),
        "by_strategy": realized_by_strategy(positions),
        "monthly_returns": [{**r, "dietz_pct": md.get(r["month"])} for r in monthly_twr(values, flows)],
        "twr_pct": round(twr(values, flows) * 100, 2),
        "naive_growth_pct": round((values[-1][1] / values[0][1] - 1) * 100, 2),
        "split": split,
        "benchmark": compare_to_benchmarks(values, flows, benchmarks),
    }


def _money(x) -> str:
    return "" if x is None else (f"-${abs(x):,.2f}" if x < 0 else f"${x:,.2f}")


def _pct(x) -> str:
    return "" if x is None else f"{x:+.2f}%"


def to_markdown(r: dict, synthetic: bool) -> str:
    b = r["benchmark"]
    end = r["split"][-1]
    names = [k for k in b["cumulative_pct"] if k != "Portfolio (TWR)"]
    lines = ["# Performance report", ""]
    if synthetic:
        lines += ["> SYNTHETIC DEMO DATA. Account values, fills and the SPY/QQQ series are all made up.", ""]
    lines += [
        f"Period: {b['start']} to {b['end']}. Not investment advice.",
        "",
        "## Growth, with deposits backed out",
        "",
        "| | |",
        "|---|---|",
        f"| Account value, start | {_money(end['starting_capital'])} |",
        f"| Net contributions (deposits - withdrawals) | {_money(end['net_contributions'])} |",
        f"| Market gain | {_money(end['market_gain'])} |",
        f"| Account value, end | {_money(end['value'])} |",
        f"| Naive growth (end / start - 1, deposits counted as gains) | {_pct(r['naive_growth_pct'])} |",
        f"| **Time-weighted return** | **{_pct(r['twr_pct'])}** |",
    ]
    for n in names:
        lines.append(f"| {n} total return, same dates | {_pct(b['cumulative_pct'][n])} |")
    lines += ["", "## Monthly: portfolio vs index", ""]
    head = "| Month | TWR | Modified Dietz | " + " | ".join(f"{n} | vs {n}" for n in names) + " |"
    lines += [head, "|" + "---|" * (3 + 2 * len(names))]
    dietz = {m["month"]: m["dietz_pct"] for m in r["monthly_returns"]}
    for row in b["monthly"]:
        cells = [row["month"], _pct(row["portfolio_pct"]), _pct(dietz.get(row["month"]))]
        for n in names:
            cells += [_pct(row[f"{n}_pct"]), _pct(row[f"excess_vs_{n}_pct"])]
        lines.append("| " + " | ".join(cells) + " |")
    lines += [
        "",
        "## Realized P&L by month",
        "",
        "Return on capital deployed for positions closed that month. Open positions are excluded.",
        "",
        "| Month | Trades | Win rate | Realized P&L | Capital deployed | RoR | Cumulative P&L | Cumulative RoR |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for m in r["monthly_realized"]:
        lines.append(
            f"| {m['month']} | {m['trades']} | {m['win_rate_pct']:.0f}% | {_money(m['realized_pnl'])} | "
            f"{_money(m['capital_deployed'])} | {_pct(m['ror_pct'])} | {_money(m['cumulative_pnl'])} | {_pct(m['cumulative_ror_pct'])} |"
        )
    lines += ["", "## Realized P&L by strategy", "", "| Strategy | Trades | Win rate | Realized P&L | Capital deployed | RoR |", "|---|---|---|---|---|---|"]
    for s in r["by_strategy"]:
        lines.append(
            f"| {s['strategy']} | {s['trades']} | {s['win_rate_pct']:.0f}% | {_money(s['realized_pnl'])} | "
            f"{_money(s['capital_deployed'])} | {_pct(s['ror_pct'])} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
