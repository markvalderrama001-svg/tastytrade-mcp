"""The safety model: dry-run first, three gates before anything goes live."""
from __future__ import annotations

import asyncio

import pytest

import safety

ORDER = object()  # safe_place never inspects the order; it just forwards it


def place(account, confirm=""):
    return asyncio.run(safety.safe_place(account, None, ORDER, confirm=confirm))


def test_default_is_dry_run_only(account, clean_env):
    result = place(account, confirm="CONFIRM")
    assert result["status"] == "DRY_RUN_ONLY"
    assert [c[0] for c in account.calls] == ["dry_run"]
    assert account.live_calls == []


def test_dry_run_effect_is_always_reported(account, clean_env):
    result = place(account)
    assert result["buying_power_change"] == "-18750.00"
    assert result["warnings"] == []


@pytest.mark.parametrize("value", ["false", "", "1", "yes", "on", "enabled", "truee"])
def test_only_literal_true_enables_live(account, clean_env, value):
    clean_env.setenv("LIVE_TRADING_ENABLED", value)
    clean_env.setenv("MCP_AUTH_TOKEN", "test-token")
    assert place(account, confirm="CONFIRM")["status"] == "DRY_RUN_ONLY"
    assert account.live_calls == []


@pytest.mark.parametrize("value", ["true", "TRUE", " True "])
def test_live_flag_is_case_and_space_insensitive(clean_env, value):
    clean_env.setenv("LIVE_TRADING_ENABLED", value)
    assert safety.live_trading_enabled() is True


def test_fail_closed_without_auth_token(account, clean_env):
    clean_env.setenv("LIVE_TRADING_ENABLED", "true")
    result = place(account, confirm="CONFIRM")
    assert result["status"] == "BLOCKED"
    assert account.live_calls == []


def test_whitespace_auth_token_counts_as_unset(account, clean_env):
    clean_env.setenv("LIVE_TRADING_ENABLED", "true")
    clean_env.setenv("MCP_AUTH_TOKEN", "   ")
    assert place(account, confirm="CONFIRM")["status"] == "BLOCKED"
    assert account.live_calls == []


@pytest.mark.parametrize("confirm", ["", "confirm", "Confirm", "yes", "CONFIRM ", True])
def test_live_requires_exact_confirm_phrase(account, clean_env, confirm):
    clean_env.setenv("LIVE_TRADING_ENABLED", "true")
    clean_env.setenv("MCP_AUTH_TOKEN", "test-token")
    result = place(account, confirm=confirm)
    assert result["status"] == "NEEDS_CONFIRMATION"
    assert account.live_calls == []


def test_all_gates_open_places_exactly_once_after_dry_run(account, clean_env):
    clean_env.setenv("LIVE_TRADING_ENABLED", "true")
    clean_env.setenv("MCP_AUTH_TOKEN", "test-token")
    result = place(account, confirm="CONFIRM")
    assert result["status"] == "PLACED"
    assert result["order_id"] == 900001
    assert [c[0] for c in account.calls] == ["dry_run", "live"]


def test_dry_run_failure_aborts_before_any_live_call(clean_env):
    clean_env.setenv("LIVE_TRADING_ENABLED", "true")
    clean_env.setenv("MCP_AUTH_TOKEN", "test-token")

    class RejectingAccount:
        calls = []

        async def place_order(self, session, order, dry_run=True):
            self.calls.append(dry_run)
            raise ValueError("broker rejected dry-run")

    acct = RejectingAccount()
    with pytest.raises(ValueError):
        place(acct, confirm="CONFIRM")
    assert acct.calls == [True]
