"""Watchlist access.

Tastytrade has two kinds:
  - private:  the watchlists you built in the platform (Watchlist)
  - public:   Tastytrade's curated preset lists (PublicWatchlist)

VERIFY ON FIRST RUN: the entry container attribute (.watchlist_entries) and the
per-entry key ('symbol'). If smoke_test prints empty symbol lists, inspect one
watchlist object and adjust _entries()/_symbols() below.
"""
from __future__ import annotations

from tastytrade.watchlists import PrivateWatchlist, PublicWatchlist


async def list_watchlists(session) -> list[dict]:
    wls = await PrivateWatchlist.get(session)
    return [{"name": w.name, "symbol_count": len(_entries(w))} for w in wls]


async def get_watchlist_symbols(session, name: str) -> list[str]:
    wl = await PrivateWatchlist.get(session, name)
    return _symbols(wl)


async def list_public_watchlists(session) -> list[str]:
    wls = await PublicWatchlist.get(session)
    return [w.name for w in wls]


def _entries(wl) -> list:
    return getattr(wl, "watchlist_entries", None) or []


def _symbols(wl) -> list[str]:
    out: list[str] = []
    for e in _entries(wl):
        if isinstance(e, dict):
            out.append(e.get("symbol") or e.get("Symbol"))
        else:
            out.append(getattr(e, "symbol", None))
    return [s for s in out if s]
