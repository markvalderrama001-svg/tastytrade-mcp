"""Order construction for equities and single-leg options.

Price sign convention (Tastytrade / tastyware): the order price is SIGNED.
  negative = debit  (money leaving the account -> you pay)
  positive = credit (money entering the account -> you receive)

For a single leg this follows the action:
  BUY_TO_OPEN / BUY_TO_CLOSE   -> debit  -> negative price
  SELL_TO_OPEN / SELL_TO_CLOSE -> credit -> positive price
So callers always pass a POSITIVE limit_price (the premium / share price) and we
apply the correct sign from the action. Multi-leg spreads (net debit/credit) are
not handled here yet.

VERIFY ON FIRST RUN: get_option_chain return shape (dict keyed by expiration
date) and Option attributes (.option_type, .strike_price). Matching is written
defensively; if an option order can't find a contract you know exists, print one
Option object and adjust the match in _find_option().
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from tastytrade.instruments import Equity, Option, OptionType, get_option_chain
from tastytrade.order import LimitOrder, OrderAction, OrderTimeInForce

_ACTIONS = {
    "BUY_TO_OPEN": OrderAction.BUY_TO_OPEN,
    "SELL_TO_OPEN": OrderAction.SELL_TO_OPEN,
    "BUY_TO_CLOSE": OrderAction.BUY_TO_CLOSE,
    "SELL_TO_CLOSE": OrderAction.SELL_TO_CLOSE,
}
_BUY_ACTIONS = {OrderAction.BUY_TO_OPEN, OrderAction.BUY_TO_CLOSE}


def _resolve_action(action: str) -> OrderAction:
    key = str(action).strip().upper()
    if key not in _ACTIONS:
        raise ValueError(f"Unknown action {action!r}. Use one of {list(_ACTIONS)}.")
    return _ACTIONS[key]


def _resolve_option_type(option_type: str) -> OptionType:
    key = str(option_type).strip().upper()
    if key in ("C", "CALL"):
        return OptionType.CALL
    if key in ("P", "PUT"):
        return OptionType.PUT
    raise ValueError(f"option_type must be C/CALL or P/PUT, got {option_type!r}.")


def _resolve_tif(tif: str) -> OrderTimeInForce:
    try:
        return OrderTimeInForce[str(tif).strip().upper()]
    except KeyError:
        raise ValueError(f"Unknown time-in-force {tif!r}. Use DAY, GTC, or IOC.")


def _signed_price(limit_price: float, action: OrderAction) -> Decimal:
    magnitude = abs(Decimal(str(limit_price)))
    return -magnitude if action in _BUY_ACTIONS else magnitude


def _norm_exp(d) -> str:
    return d.isoformat() if hasattr(d, "isoformat") else str(d)


# ------------------------- equities -------------------------
async def build_equity_order(
    session,
    symbol: str,
    quantity: int,
    limit_price: float,
    action: str = "BUY_TO_OPEN",
    tif: str = "DAY",
) -> LimitOrder:
    act = _resolve_action(action)
    instrument = await Equity.get(session, symbol)
    leg = instrument.build_leg(Decimal(str(quantity)), act)
    return LimitOrder(
        time_in_force=_resolve_tif(tif),
        legs=[leg],
        price=_signed_price(limit_price, act),
    )


# ------------------------- options --------------------------
async def list_expirations(session, underlying: str) -> list[str]:
    chain = await get_option_chain(session, underlying)
    return sorted({_norm_exp(k) for k in chain.keys()})


async def list_strikes(session, underlying: str, expiration: str) -> list[dict]:
    chain = await get_option_chain(session, underlying)
    want = _parse_date(expiration)
    strikes: dict[str, dict] = {}
    for exp_key, opts in chain.items():
        if _norm_exp(exp_key) != want:
            continue
        for o in opts:
            s = str(getattr(o, "strike_price", None))
            row = strikes.setdefault(s, {"strike": s, "call": False, "put": False})
            if getattr(o, "option_type", None) == OptionType.CALL:
                row["call"] = True
            elif getattr(o, "option_type", None) == OptionType.PUT:
                row["put"] = True
    return [strikes[s] for s in sorted(strikes, key=lambda x: Decimal(x))]


def _parse_date(expiration: str) -> str:
    """Accept 'YYYY-MM-DD' (or a date) and return normalized ISO string."""
    if hasattr(expiration, "isoformat"):
        return expiration.isoformat()
    return date.fromisoformat(str(expiration).strip()).isoformat()


async def _find_option(session, underlying, expiration, strike, option_type) -> Option:
    chain = await get_option_chain(session, underlying)
    want_exp = _parse_date(expiration)
    ot = _resolve_option_type(option_type)
    want_strike = Decimal(str(strike))
    for exp_key, opts in chain.items():
        if _norm_exp(exp_key) != want_exp:
            continue
        for o in opts:
            if getattr(o, "option_type", None) != ot:
                continue
            if Decimal(str(getattr(o, "strike_price", "nan"))) == want_strike:
                return o
    raise ValueError(
        f"No {option_type} {underlying} {strike} exp {want_exp} found. "
        f"Check expirations via list_expirations / strikes via list_strikes."
    )


async def build_option_order(
    session,
    underlying: str,
    expiration: str,
    strike: float,
    option_type: str,
    quantity: int,
    limit_price: float,
    action: str = "BUY_TO_OPEN",
    tif: str = "DAY",
) -> LimitOrder:
    act = _resolve_action(action)
    option = await _find_option(session, underlying, expiration, strike, option_type)
    leg = option.build_leg(Decimal(str(quantity)), act)
    return LimitOrder(
        time_in_force=_resolve_tif(tif),
        legs=[leg],
        price=_signed_price(limit_price, act),
    )
