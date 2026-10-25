"""Order safety rails.

No order EVER goes live unless ALL of these are true:
  1. LIVE_TRADING_ENABLED=true in the environment (operator gate), AND
  2. MCP_AUTH_TOKEN is set (fail-closed: a server that anyone could call
     must never be able to trade), AND
  3. the caller passes confirm='CONFIRM' for that specific order (per-call gate).

Every order is dry-run first, so the buying-power effect and any warnings are
always known before anything could be placed. This is the single choke point
for placing orders -- never call account.place_order(dry_run=False) anywhere
else in the codebase (tests/test_chokepoint.py enforces this).
"""
from __future__ import annotations

import os

CONFIRM_PHRASE = "CONFIRM"


def live_trading_enabled() -> bool:
    return os.environ.get("LIVE_TRADING_ENABLED", "false").strip().lower() == "true"


def endpoint_auth_configured() -> bool:
    return bool(os.environ.get("MCP_AUTH_TOKEN", "").strip())


async def safe_place(account, session, order, *, confirm: str = "") -> dict:
    # Always dry-run first: validates the order, returns real BP effect + fees.
    dry = await account.place_order(session, order, dry_run=True)
    effect = _summarize(dry)

    if not live_trading_enabled():
        return {
            "status": "DRY_RUN_ONLY",
            "note": "LIVE_TRADING_ENABLED is false. Nothing was placed.",
            **effect,
        }

    if not endpoint_auth_configured():
        return {
            "status": "BLOCKED",
            "note": "Live trading requires MCP_AUTH_TOKEN to be set. "
            "Refusing to place on an unauthenticated server.",
            **effect,
        }

    if confirm != CONFIRM_PHRASE:
        return {
            "status": "NEEDS_CONFIRMATION",
            "note": "Re-call with confirm='CONFIRM' to place this live order.",
            **effect,
        }

    live = await account.place_order(session, order, dry_run=False)
    return {"status": "PLACED", "order_id": live.order.id, **effect}


def _summarize(resp) -> dict:
    bpe = getattr(resp, "buying_power_effect", None)
    change = getattr(bpe, "change_in_buying_power", None) if bpe else None
    warnings = getattr(resp, "warnings", None) or []
    return {
        "buying_power_change": str(change) if change is not None else None,
        "warnings": [str(w) for w in warnings],
    }
