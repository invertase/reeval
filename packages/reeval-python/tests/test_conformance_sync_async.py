"""Sync and async eval bodies emit identical attempt-protocol exec/expect calls."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from reeval_python.context import AttemptContext, SyncAttemptContext
from reeval_python.expect import expect

PKG_ROOT = Path(__file__).resolve().parents[1]
GOLDEN = PKG_ROOT.parent / "reeval" / "test" / "conformance" / "context" / "sync-async.ndjson"


def _golden_runner_calls() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in GOLDEN.read_text().splitlines():
        if not line.strip():
            continue
        msg = json.loads(line)
        runner = msg.get("runner")
        if isinstance(runner, dict) and "call" in runner:
            out.append(runner["call"])
    return out


async def _fake_send(message: dict[str, Any], calls: list[dict[str, Any]]) -> dict[str, Any]:
    call = message["call"]
    calls.append(call)
    if call["op"] == "exec":
        return {
            "ok": True,
            "op": "exec",
            "result": {"exitCode": 0, "stdout": "sync-async-ok\n", "stderr": ""},
        }
    if call["op"] == "expect":
        return {
            "ok": True,
            "op": "expect",
            "assertion": {"status": "pass", "matcher": call["matcher"], "soft": False},
        }
    raise AssertionError(call["op"])


async def _run_sync_body(body: Callable[[SyncAttemptContext], None]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> dict[str, Any]:
        return await _fake_send(message, calls)

    loop = asyncio.get_running_loop()
    async_ctx = AttemptContext("fake/-/fake#1", send)
    sync_ctx = SyncAttemptContext(async_ctx, loop)
    sync_ctx.bind_expect()
    await asyncio.to_thread(body, sync_ctx)
    return calls


async def _run_async_body(
    body: Callable[[AttemptContext], Awaitable[None]],
) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> dict[str, Any]:
        return await _fake_send(message, calls)

    async_ctx = AttemptContext("fake/-/fake#1", send)
    async_ctx.bind_expect()
    await body(async_ctx)
    return calls


def test_sync_and_async_emit_same_runner_calls() -> None:
    golden = _golden_runner_calls()

    def sync_body(c: SyncAttemptContext) -> None:
        expect(c.exec("echo sync-async-ok")).to_succeed()

    async def async_body(c: AttemptContext) -> None:
        await expect(await c.exec("echo sync-async-ok")).to_succeed()

    sync_calls = asyncio.run(_run_sync_body(sync_body))
    async_calls = asyncio.run(_run_async_body(async_body))

    assert sync_calls == golden
    assert async_calls == golden
