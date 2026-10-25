"""PNG charts for the performance report (matplotlib, headless)."""
from __future__ import annotations

from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

INK, MUTED, GRID = "#1f2328", "#656d76", "#d8dee4"
COLORS = {"Portfolio (TWR)": "#0969da", "SPY": "#bf8700", "QQQ": "#8250df"}
STRATEGY_COLORS = {
    "CSP": "#0969da",
    "covered call": "#1a7f37",
    "spread": "#bf8700",
    "LEAP": "#8250df",
    "long option": "#cf222e",
    "stock": "#57606a",
}
dollars = FuncFormatter(lambda x, _: f"-${abs(x):,.0f}" if x < 0 else f"${x:,.0f}")


def _style(ax, title: str, note: str | None) -> None:
    if title:
        ax.set_title(title, loc="left", fontsize=13, fontweight="bold", color=INK, pad=22)
    if note:
        ax.text(0, 1.02, note, transform=ax.transAxes, fontsize=9, color=MUTED)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=9)


def growth_vs_index(report: dict, out: Path, note: str | None = None) -> Path:
    b = report["benchmark"]
    split = report["split"]
    fig, ax = plt.subplots(figsize=(10, 5.2), dpi=130)
    for name, path in b["growth"].items():
        xs, ys = zip(*path)
        ax.plot(xs, ys, color=COLORS.get(name, INK), linewidth=2.2 if name.startswith("Portfolio") else 1.6,
                label=f"{name}  {b['cumulative_pct'][name]:+.1f}%")
    start = split[0]["value"]
    xs = [date.fromisoformat(s["date"]) for s in split]
    ax.plot(xs, [s["value"] / start * 10_000 for s in split], color=MUTED, linestyle=":", linewidth=1.4,
            label=f"Account value incl. deposits  {report['naive_growth_pct']:+.1f}%")
    ax.yaxis.set_major_formatter(dollars)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %y"))
    _style(ax, "Growth of $10,000: time-weighted return vs SPY and QQQ total return", note)
    ax.legend(frameon=False, fontsize=9, loc="upper left")
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)
    return out


def monthly_realized(report: dict, out: Path, note: str | None = None) -> Path:
    rows = report["monthly_realized"]
    months = [r["month"] for r in rows]
    by_month_strategy: dict[str, dict[str, float]] = {m: {} for m in months}
    for p in report["positions"]:
        cell = by_month_strategy[p["month"]]
        cell[p["strategy"]] = cell.get(p["strategy"], 0.0) + p["realized_pnl"]
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(10, 6.4), dpi=130, sharex=True,
                                  gridspec_kw={"height_ratios": [3, 2]})
    x = list(range(len(months)))
    pos_base, neg_base = [0.0] * len(months), [0.0] * len(months)
    for strat, color in STRATEGY_COLORS.items():
        vals = [by_month_strategy[m].get(strat, 0.0) for m in months]
        if not any(vals):
            continue
        bottoms = [pos_base[i] if v >= 0 else neg_base[i] for i, v in enumerate(vals)]
        ax.bar(x, vals, bottom=bottoms, color=color, width=0.65, label=strat)
        for i, v in enumerate(vals):
            if v >= 0:
                pos_base[i] += v
            else:
                neg_base[i] += v
    ax.axhline(0, color=MUTED, linewidth=0.8)
    ax.yaxis.set_major_formatter(dollars)
    ax.set_ylabel("Realized P&L", color=MUTED, fontsize=9)
    top, bottom = max(pos_base, default=0.0), min(neg_base, default=0.0)
    span = (top - bottom) or 1.0
    ax.set_ylim(bottom - 0.08 * span, top + 0.25 * span)  # headroom for the legend
    _style(ax, "Realized P&L by month, by strategy, and return on capital deployed", note)
    ax.legend(frameon=False, fontsize=8, loc="upper left", ncol=5)

    rors = [r["ror_pct"] or 0.0 for r in rows]
    ax2.bar(x, rors, width=0.65, color=["#1a7f37" if v >= 0 else "#cf222e" for v in rors])
    for i, v in enumerate(rors):
        ax2.annotate(f"{v:+.1f}%", (i, v), textcoords="offset points", xytext=(0, 4 if v >= 0 else -12),
                     ha="center", fontsize=8, color=INK)
    ax2.axhline(0, color=MUTED, linewidth=0.8)
    ax2.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.0f}%"))
    ax2.set_ylabel("RoR on capital", color=MUTED, fontsize=9)
    ax2.margins(y=0.25)
    _style(ax2, "", None)
    ax2.set_xticks(x)
    ax2.set_xticklabels([f"{m[5:]}/{m[2:4]}" for m in months])
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)
    return out


def contributions_vs_gains(report: dict, out: Path, note: str | None = None) -> Path:
    split = report["split"]
    xs = [date.fromisoformat(s["date"]) for s in split]
    start = [s["starting_capital"] for s in split]
    contrib = [s["net_contributions"] for s in split]
    gain = [s["market_gain"] for s in split]
    fig, ax = plt.subplots(figsize=(10, 5.2), dpi=130)
    ax.stackplot(xs, start, contrib, labels=["Starting capital", "Net deposits"], colors=["#d0d7de", "#9a6700"], alpha=0.9)
    base = [a + c for a, c in zip(start, contrib)]
    ax.fill_between(xs, base, [b + g for b, g in zip(base, gain)], where=[g >= 0 for g in gain],
                    color="#1a7f37", alpha=0.75, label="Market gain", interpolate=True)
    if any(g < 0 for g in gain):
        ax.fill_between(xs, base, [b + g for b, g in zip(base, gain)], where=[g < 0 for g in gain],
                        color="#cf222e", alpha=0.75, label="Market loss", interpolate=True)
    ax.plot(xs, [s["value"] for s in split], color=INK, linewidth=1.4, label="Account value")
    end = split[-1]
    ax.annotate(f"deposits {dollars(end['net_contributions'])}\nmarket gain {dollars(end['market_gain'])}",
                (xs[-1], end["value"]), textcoords="offset points", xytext=(-175, -70), fontsize=9, color=INK,
                bbox={"boxstyle": "round,pad=0.4", "fc": "white", "ec": GRID})
    ax.yaxis.set_major_formatter(dollars)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %y"))
    _style(ax, "Where the growth came from: deposits vs market returns", note)
    ax.legend(frameon=False, fontsize=9, loc="upper left")
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)
    return out
