"""Authentication + shared session/account helpers.

Auth model: OAuth2 personal grant. You store a client secret and a refresh
token; the SDK trades them for short-lived (15 min) access tokens automatically
and refreshes before every request. You never write refresh logic yourself.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv
from tastytrade import Account, Session

load_dotenv()


def get_session() -> Session:
    """Build an authenticated live session from .env credentials."""
    secret = os.environ.get("TASTY_CLIENT_SECRET")
    refresh = os.environ.get("TASTY_REFRESH_TOKEN")
    if not secret or not refresh:
        raise RuntimeError(
            "Missing TASTY_CLIENT_SECRET or TASTY_REFRESH_TOKEN. "
            "Copy .env.example to .env and fill them in."
        )
    # is_test=False -> LIVE account. We stay on live and rely on dry_run for
    # safety (Tastytrade's dry-run runs against the real account but places
    # nothing). Set is_test=True only if you later wire up a cert account.
    return Session(secret, refresh)


async def get_account(session: Session) -> Account:
    """Return the first (or only) account on this login."""
    accounts = await Account.get(session)
    if not accounts:
        raise RuntimeError("No accounts found for this login.")
    return accounts[0]
