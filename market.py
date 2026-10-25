"""Real-time quotes via the DXLink streamer (websocket, not REST)."""
from __future__ import annotations

from tastytrade import DXLinkStreamer
from tastytrade.dxfeed import Quote


async def get_quote(session, symbol: str) -> dict:
    """One-shot bid/ask snapshot for a symbol.

    Opens a streamer, waits for the first Quote event, returns it. For a tool
    that polls many symbols often, keep a single long-lived streamer instead of
    opening one per call.
    """
    async with DXLinkStreamer(session) as streamer:
        await streamer.subscribe(Quote, [symbol])
        q = await streamer.get_event(Quote)
        return {
            "symbol": getattr(q, "event_symbol", symbol),
            "bid": str(getattr(q, "bid_price", None)),
            "ask": str(getattr(q, "ask_price", None)),
        }
