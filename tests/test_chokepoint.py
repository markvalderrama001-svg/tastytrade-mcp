"""Structural guarantees: live placement exists in exactly one place per runtime.

These read the source rather than run it, so a future edit that adds a second
path to the broker fails CI even if no other test exercises it.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_FILES = [p for p in ROOT.glob("*.py")]
WORKER = ROOT / "worker" / "tastytrade-mcp-worker.js"


def _worker_src() -> str:
    # Normalise line endings so the checks hold on CRLF checkouts too.
    return WORKER.read_text(encoding="utf-8").replace("\r\n", "\n")


def test_python_live_placement_only_in_safety():
    hits = {p.name for p in PY_FILES if "dry_run=False" in p.read_text(encoding="utf-8")}
    assert hits == {"safety.py"}


def test_python_place_order_calls_only_in_safety():
    pattern = re.compile(r"\.place_order\(")
    hits = {p.name for p in PY_FILES if pattern.search(p.read_text(encoding="utf-8"))}
    # demo.py defines a fake account's place_order; it never calls the SDK.
    assert hits <= {"safety.py"}


def test_worker_live_order_post_only_in_safe_place():
    src = _worker_src()
    live_posts = [m.start() for m in re.finditer(r'"POST",\s*`/accounts/\$\{acct\}/orders`', src)]
    assert len(live_posts) == 1, "exactly one live order POST in the worker"
    start = src.index("async function safePlace(")
    end = src.index("\n}\n", start)
    assert start < live_posts[0] < end, "the live POST must sit inside safePlace"


def test_worker_safe_place_gate_order():
    src = _worker_src()
    body = src[src.index("async function safePlace("):]
    body = body[: body.index("\n}\n")]
    dry = body.index("/orders/dry-run")
    live_flag = body.index("liveEnabled(env)")
    auth = body.index("env.MCP_AUTH_TOKEN")
    confirm = body.index('confirm !== "CONFIRM"')
    live = body.index("/orders`, order")
    assert dry < live_flag < auth < confirm < live
