"""Synthetic demo data. Every number here is made up.

Seeded, so the demo, the charts and the tests see the same data on every run.
- 12 months of business days, Oct 2025 to Sep 2026.
- "SPY" and "QQQ" here are SYNTHETIC total-return paths that only borrow the
  ticker names for labelling. They are not real index history.
- Account values follow a made-up return process plus four external cash flows
  (three deposits and one withdrawal).
- Option and stock fills in the Tastytrade REST transaction shape, covering
  CSPs, covered calls, credit spreads, an iron condor, a LEAP and a stock trade.
- The account-value series and the fills are generated separately, so the
  realized P&L will not reconcile to the change in account value. Each one only
  has to exercise its own math.
"""
from __future__ import annotations

import random
from datetime import date, datetime, timedelta

START = date(2025, 10, 1)
END = date(2026, 9, 30)
STARTING_VALUE = 25_000.0

# (requested date, amount): deposits positive, withdrawal negative. Synthetic.
FLOW_PLAN = [
    (date(2025, 12, 15), 3_000.0),
    (date(2026, 3, 2), 5_000.0),
    (date(2026, 6, 15), 2_500.0),
    (date(2026, 8, 3), -1_500.0),
]


def business_days(start: date = START, end: date = END) -> list[date]:
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _snap(d: date, days: list[date]) -> date:
    return next(x for x in days if x >= d)


def demo_series(seed: int = 7):
    """Returns (values, flows, benchmarks) for the demo."""
    rng = random.Random(seed)
    days = business_days()
    flows = [(_snap(d, days), amt) for d, amt in FLOW_PLAN]
    flow_on = dict(flows)

    spy, qqq, acct = [(days[0], 100.0)], [(days[0], 100.0)], [(days[0], STARTING_VALUE)]
    for d in days[1:]:
        m = rng.gauss(0.0005, 0.009)
        q = 1.25 * m + rng.gauss(0.0001, 0.005)
        a = 0.9 * m + 0.0004 + rng.gauss(0, 0.005)  # premium carry plus market beta
        spy.append((d, spy[-1][1] * (1 + m)))
        qqq.append((d, qqq[-1][1] * (1 + q)))
        acct.append((d, acct[-1][1] * (1 + a) + flow_on.get(d, 0.0)))
    values = [(d, round(v, 2)) for d, v in acct]
    benchmarks = {"SPY": spy, "QQQ": qqq}
    return values, flows, benchmarks


# ---------------- transactions ----------------
_FEE_OPEN, _FEE_CLOSE = 1.14, 0.14  # per contract, synthetic


def _occ(root: str, exp: date, right: str, strike: float) -> str:
    return f"{root:<6}{exp:%y%m%d}{right}{int(round(strike * 1000)):08d}"


class _Book:
    def __init__(self):
        self.items: list[dict] = []
        self.order_id = 700000  # synthetic order ids

    def next_order(self) -> int:
        self.order_id += 1
        return self.order_id

    def fill(self, when: datetime, action: str, symbol: str, root: str, qty: int, price: float, order_id: int, option=True):
        mult = 100 if option else 1
        value = round(price * qty * mult, 2)
        credit = action.startswith("Sell")
        fee = (_FEE_OPEN if "Open" in action else _FEE_CLOSE) * qty if option else 0.0
        net = value - fee if credit else value + fee
        self.items.append(
            {
                "transaction-type": "Trade",
                "action": action,
                "symbol": symbol,
                "underlying-symbol": root,
                "instrument-type": "Equity Option" if option else "Equity",
                "quantity": str(qty),
                "price": f"{price:.2f}",
                "value": f"{value:.2f}",
                "value-effect": "Credit" if credit else "Debit",
                "net-value": f"{net:.2f}",
                "net-value-effect": "Credit" if credit else "Debit",
                "executed-at": when.strftime("%Y-%m-%dT%H:%M:%S.000+00:00"),
                "order-id": order_id,
            }
        )


_TICKERS = {"KO": 62.0, "F": 11.0, "T": 22.0, "BAC": 41.0, "INTC": 22.0, "CSCO": 55.0, "PFE": 27.0}


def demo_transactions(seed: int = 11) -> list[dict]:
    rng = random.Random(seed)
    book = _Book()
    names = list(_TICKERS)

    def at(d: date, hour=15) -> datetime:
        return datetime(d.year, d.month, d.day, hour, 0, 0)

    month_starts = [date(2025, 10, 6) + timedelta(days=30 * i) for i in range(12)]
    for i, m0 in enumerate(month_starts):
        # Two cash-secured puts a month, ~45 DTE, mostly closed near 50% of max profit.
        for k in range(2):
            root = names[(2 * i + k) % len(names)]
            px = _TICKERS[root] * (1 + rng.uniform(-0.05, 0.05))
            strike = round(px * 0.93)
            exp = m0 + timedelta(days=45)
            sym = _occ(root, exp, "P", strike)
            credit = round(strike * rng.uniform(0.012, 0.022), 2)
            oid = book.next_order()
            book.fill(at(m0 + timedelta(days=k)), "Sell to Open", sym, root, 1, credit, oid)
            if rng.random() < 0.85:
                close_px = round(credit * rng.uniform(0.35, 0.55), 2)
            else:  # the one that went against us
                close_px = round(credit * rng.uniform(1.6, 2.6), 2)
            book.fill(at(m0 + timedelta(days=rng.randint(14, 24) + k)), "Buy to Close", sym, root, 1, close_px, book.next_order())

        # Covered call every other month.
        if i % 2 == 1:
            root = names[(i + 3) % len(names)]
            strike = round(_TICKERS[root] * 1.05)
            exp = m0 + timedelta(days=35)
            sym = _occ(root, exp, "C", strike)
            credit = round(strike * rng.uniform(0.008, 0.015), 2)
            book.fill(at(m0 + timedelta(days=2)), "Sell to Open", sym, root, 1, credit, book.next_order())
            book.fill(at(m0 + timedelta(days=20)), "Buy to Close", sym, root, 1, round(credit * rng.uniform(0.3, 0.6), 2), book.next_order())

        # Put credit spread every third month, iron condor in month 5.
        if i % 3 == 0:
            root = "BAC"
            short_k = round(_TICKERS[root] * 0.95)
            long_k = short_k - 3
            exp = m0 + timedelta(days=40)
            legs = [(_occ(root, exp, "P", short_k), "Sell"), (_occ(root, exp, "P", long_k), "Buy")]
            oid = book.next_order()
            short_px, long_px = round(rng.uniform(0.9, 1.2), 2), round(rng.uniform(0.35, 0.5), 2)
            for (sym, side), px in zip(legs, (short_px, long_px)):
                book.fill(at(m0 + timedelta(days=3)), f"{side} to Open", sym, root, 2, px, oid)
            cid = book.next_order()
            win = rng.random() < 0.75
            for (sym, side), px in zip(legs, (short_px, long_px)):
                close = px * (0.4 if win else 1.8) if side == "Sell" else px * (0.6 if win else 1.4)
                book.fill(at(m0 + timedelta(days=21)), "Buy to Close" if side == "Sell" else "Sell to Close", sym, root, 2, round(close, 2), cid)
        if i == 5:
            root = "CSCO"
            exp = m0 + timedelta(days=38)
            k = {"pl": 49, "ps": 52, "cs": 58, "cl": 61}
            legs = [
                (_occ(root, exp, "P", k["pl"]), "Buy", 0.30),
                (_occ(root, exp, "P", k["ps"]), "Sell", 0.85),
                (_occ(root, exp, "C", k["cs"]), "Sell", 0.80),
                (_occ(root, exp, "C", k["cl"]), "Buy", 0.28),
            ]
            oid = book.next_order()
            for sym, side, px in legs:
                book.fill(at(m0 + timedelta(days=4)), f"{side} to Open", sym, root, 1, px, oid)
            cid = book.next_order()
            for sym, side, px in legs:
                book.fill(at(m0 + timedelta(days=24)), "Buy to Close" if side == "Sell" else "Sell to Close", sym, root, 1, round(px * 0.45, 2), cid)

    # One LEAP: bought Oct 2025 with ~15 months to expiry, sold Jun 2026.
    leap = _occ("CSCO", date(2027, 1, 15), "C", 45)
    book.fill(at(date(2025, 10, 14)), "Buy to Open", leap, "CSCO", 1, 12.40, book.next_order())
    book.fill(at(date(2026, 6, 10)), "Sell to Close", leap, "CSCO", 1, 15.85, book.next_order())

    # One stock trade.
    book.fill(at(date(2026, 1, 12)), "Buy to Open", "KO", "KO", 50, 61.20, book.next_order(), option=False)
    book.fill(at(date(2026, 4, 20)), "Sell to Close", "KO", "KO", 50, 64.05, book.next_order(), option=False)

    book.items.sort(key=lambda t: t["executed-at"])
    return book.items
