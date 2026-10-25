"""Runs the Worker's own checks from pytest, so one command covers both runtimes.

Skipped (not failed) when Node.js is not installed.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

WORKER_DIR = Path(__file__).resolve().parents[1] / "worker"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="node not installed")


def test_worker_syntax_check():
    subprocess.run([NODE, "--check", "tastytrade-mcp-worker.js"], cwd=WORKER_DIR, check=True)


def test_worker_node_test_suite():
    proc = subprocess.run(
        [NODE, "--test", "test/worker.test.mjs"], cwd=WORKER_DIR, capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
