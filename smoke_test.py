"""Run this FIRST (after filling .env) to confirm auth + reads work.

    py smoke_test.py

Everything here is read-only. Nothing is traded. The account number is never
printed.
"""
import asyncio

from auth import get_account, get_session
from market import get_quote
from watchlists import list_watchlists


async def main():
    session = get_session()
    account = await get_account(session)
    print("[ok] Auth OK. Account found:", bool(account))

    b = await account.get_balances(session)
    print("[ok] Balances readable:", getattr(b, "net_liquidating_value", None) is not None)

    wls = await list_watchlists(session)
    print("[ok] Watchlists:", len(wls))

    q = await get_quote(session, "AAPL")
    print("[ok] AAPL quote:", q)

    print("\nAll read-only checks passed. Nothing was traded.")


if __name__ == "__main__":
    asyncio.run(main())
