"""Offline demo of the safety model. No credentials, no network, no SDK needed.

    py demo.py

Walks one synthetic AAPL limit order through safety.safe_place under each
configuration and prints what the broker was actually asked to do. The fake
account records every place_order call, so you can see that a live call only
happens when all three gates are open.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace

from safety import safe_place

FIXTURE = Path(__file__).parent / "fixtures" / "dry_run_response.json"


class FakeAccount:
    """Stands in for tastytrade.Account. Records calls instead of trading."""

    def __init__(self, fixture: dict):
        self.fixture = fixture
        self.calls: list[str] = []

    async def place_order(self, session, order, dry_run: bool = True):
        self.calls.append("dry-run" if dry_run else "LIVE")
        bpe = SimpleNamespace(**self.fixture["buying_power_effect"])
        return SimpleNamespace(
            buying_power_effect=bpe,
            warnings=self.fixture["warnings"],
            order=SimpleNamespace(id=self.fixture["placed_order_id"]),
        )


SCENARIOS = [
    ("Default config (live switch off)", {"LIVE_TRADING_ENABLED": "false"}, "CONFIRM"),
    ("Live switch on, but no MCP_AUTH_TOKEN", {"LIVE_TRADING_ENABLED": "true"}, "CONFIRM"),
    (
        "Live + auth, but Claude did not pass confirm",
        {"LIVE_TRADING_ENABLED": "true", "MCP_AUTH_TOKEN": "demo-token"},
        "",
    ),
    (
        "Live + auth + confirm='CONFIRM' (all gates open)",
        {"LIVE_TRADING_ENABLED": "true", "MCP_AUTH_TOKEN": "demo-token"},
        "CONFIRM",
    ),
]


async def run() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    order = {"symbol": "AAPL", "action": "BUY_TO_OPEN", "quantity": 100, "limit_price": 187.50}
    print("Order under test:", order, "\n")
    for title, env, confirm in SCENARIOS:
        for key in ("LIVE_TRADING_ENABLED", "MCP_AUTH_TOKEN"):
            os.environ.pop(key, None)
        os.environ.update(env)
        account = FakeAccount(fixture)
        result = await safe_place(account, session=None, order=order, confirm=confirm)
        print(f"== {title}")
        print(f"   broker calls : {' -> '.join(account.calls)}")
        print(f"   status       : {result['status']}")
        print(f"   bp change    : {result['buying_power_change']}")
        if "note" in result:
            print(f"   note         : {result['note']}")
        if "order_id" in result:
            print(f"   order id     : {result['order_id']} (synthetic)")
        print()


def main() -> None:
    saved = {k: os.environ.get(k) for k in ("LIVE_TRADING_ENABLED", "MCP_AUTH_TOKEN")}
    try:
        asyncio.run(run())
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


if __name__ == "__main__":
    main()
