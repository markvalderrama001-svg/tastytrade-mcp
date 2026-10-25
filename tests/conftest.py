"""Test setup: replace the tastytrade SDK, python-dotenv and the MCP SDK with
small in-memory stubs so the whole suite runs offline with no credentials.

The stubs mirror only the names our modules import. Order objects are plain
records, so tests can inspect exactly what would have been sent to the broker.
"""
from __future__ import annotations

import enum
import os
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _module(name: str, **attrs) -> types.ModuleType:
    mod = types.ModuleType(name)
    mod.__dict__.update(attrs)
    sys.modules[name] = mod
    return mod


# ---------------- tastytrade.order ----------------
class OrderAction(str, enum.Enum):
    BUY_TO_OPEN = "Buy to Open"
    SELL_TO_OPEN = "Sell to Open"
    BUY_TO_CLOSE = "Buy to Close"
    SELL_TO_CLOSE = "Sell to Close"


class OrderTimeInForce(str, enum.Enum):
    DAY = "Day"
    GTC = "GTC"
    IOC = "IOC"


@dataclass
class LimitOrder:
    time_in_force: OrderTimeInForce
    legs: list
    price: object


# ---------------- tastytrade.instruments ----------------
class OptionType(str, enum.Enum):
    CALL = "C"
    PUT = "P"


@dataclass
class FakeLeg:
    symbol: str
    quantity: object
    action: OrderAction


@dataclass
class Equity:
    symbol: str

    @classmethod
    async def get(cls, session, symbol):
        return cls(symbol=symbol.upper())

    def build_leg(self, quantity, action):
        return FakeLeg(self.symbol, quantity, action)


@dataclass
class Option:
    symbol: str
    strike_price: object
    option_type: OptionType
    expiration_date: object = None

    def build_leg(self, quantity, action):
        return FakeLeg(self.symbol, quantity, action)


# A synthetic chain; tests may replace FAKE_CHAIN contents.
FAKE_CHAIN: dict = {}


async def get_option_chain(session, underlying):
    return FAKE_CHAIN


_module("tastytrade", Account=object, Session=object, DXLinkStreamer=object)
_module("tastytrade.order", LimitOrder=LimitOrder, OrderAction=OrderAction, OrderTimeInForce=OrderTimeInForce)
_module(
    "tastytrade.instruments",
    Equity=Equity,
    Option=Option,
    OptionType=OptionType,
    get_option_chain=get_option_chain,
)
_module("tastytrade.dxfeed", Quote=object)


async def _no_metrics(session, symbols):
    return []


_module("tastytrade.metrics", get_market_metrics=_no_metrics)
_module("tastytrade.watchlists", PrivateWatchlist=object, PublicWatchlist=object)
_module("dotenv", load_dotenv=lambda *a, **k: None)


class _FakeFastMCP:
    def __init__(self, name):
        self.name = name
        self.tools = {}

    def tool(self):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn

        return deco

    def run(self, *a, **k):  # pragma: no cover - never called in tests
        raise RuntimeError("not in tests")


_module("mcp")
_module("mcp.server")
_module("mcp.server.fastmcp", FastMCP=_FakeFastMCP)


# ---------------- shared fixtures ----------------
@dataclass
class RecordingAccount:
    """Fake tastytrade.Account that records every place_order call."""

    calls: list = field(default_factory=list)
    change_in_buying_power: str = "-18750.00"

    async def place_order(self, session, order, dry_run=True):
        self.calls.append(("dry_run" if dry_run else "live", order))
        return types.SimpleNamespace(
            buying_power_effect=types.SimpleNamespace(change_in_buying_power=self.change_in_buying_power),
            warnings=[],
            order=types.SimpleNamespace(id=900001),  # synthetic order id
        )

    @property
    def live_calls(self):
        return [c for c in self.calls if c[0] == "live"]


@pytest.fixture
def account():
    return RecordingAccount()


@pytest.fixture
def clean_env(monkeypatch):
    for key in ("LIVE_TRADING_ENABLED", "MCP_AUTH_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


@pytest.fixture
def fake_chain():
    from datetime import date

    exp = date(2026, 12, 18)
    FAKE_CHAIN.clear()
    FAKE_CHAIN[exp] = [
        Option("AAPL  261218C00190000", "190", OptionType.CALL, exp),
        Option("AAPL  261218P00190000", "190", OptionType.PUT, exp),
        Option("AAPL  261218P00185000", "185", OptionType.PUT, exp),
        Option("AAPL  261218C00192500", "192.5", OptionType.CALL, exp),
    ]
    FAKE_CHAIN[date(2027, 1, 15)] = [
        Option("AAPL  270115C00200000", "200", OptionType.CALL, date(2027, 1, 15)),
    ]
    yield FAKE_CHAIN
    FAKE_CHAIN.clear()


os.environ.pop("LIVE_TRADING_ENABLED", None)
