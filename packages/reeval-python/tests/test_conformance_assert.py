"""Plain assert and expect produce the same attempt-protocol expect calls."""

from __future__ import annotations

import asyncio
import json
import linecache
from pathlib import Path
from typing import Any

import pytest

from reeval_python.context import AttemptContext
from reeval_python.errors import ReevalAssertionError
from reeval_python.expect import expect

PKG_ROOT = Path(__file__).resolve().parents[1]
GOLDEN = (
    PKG_ROOT.parent / "reeval" / "test" / "conformance" / "context" / "assert-equivalent.ndjson"
)


def _golden_runner_call() -> dict[str, Any]:
    for line in GOLDEN.read_text().splitlines():
        if not line.strip():
            continue
        msg = json.loads(line)
        runner = msg.get("runner")
        if isinstance(runner, dict) and "call" in runner:
            return runner["call"]
    raise AssertionError("no runner call in golden")


async def _fake_send(message: dict[str, Any], calls: list[dict[str, Any]]) -> dict[str, Any]:
    call = message["call"]
    calls.append(call)
    if call["op"] == "expect":
        left = call["subject"]["value"]
        right = call["args"][0] if call["args"] else None
        passed = left == right
        msg = call.get("label") or "assertion failed"
        if not passed:
            msg = f"{msg}: expected {left!r} to deeply equal {right!r}"
        return {
            "ok": True,
            "op": "expect",
            "assertion": {
                "status": "pass" if passed else "fail",
                "matcher": call["matcher"],
                "soft": False,
                "message": msg,
            },
        }
    raise AssertionError(call["op"])


async def _run_expect_path() -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> dict[str, Any]:
        return await _fake_send(message, calls)

    ctx = AttemptContext("fake/-/fake#1", send)
    ctx.bind_expect()
    with pytest.raises(ReevalAssertionError):
        await expect(1, "one is two").to_equal(2)
    return calls


def _assert_failure() -> AssertionError:
    path = "assert-equivalent.eval.py"
    source = "def body():\n    one = 1\n    assert one == 2, 'one is two'\nbody()\n"
    lines = source.splitlines(keepends=True)
    linecache.cache[path] = (len(source), None, lines, path)
    code = compile(source, path, "exec")
    try:
        exec(code, {})  # noqa: S102
    except AssertionError as exc:
        return exc
    raise RuntimeError("assert did not fail")


async def _run_assert_path() -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> dict[str, Any]:
        return await _fake_send(message, calls)

    ctx = AttemptContext("fake/-/fake#1", send)
    with pytest.raises(ReevalAssertionError):
        await ctx.record_plain_assert(_assert_failure())
    return calls


def test_assert_and_expect_emit_same_runner_call() -> None:
    golden = _golden_runner_call()
    expect_calls = asyncio.run(_run_expect_path())
    assert_calls = asyncio.run(_run_assert_path())
    assert expect_calls[0] == golden
    assert assert_calls[0]["matcher"] == golden["matcher"]
    assert assert_calls[0]["subject"] == golden["subject"]
    assert assert_calls[0]["args"] == golden["args"]
    assert assert_calls[0]["label"] == golden["label"]
