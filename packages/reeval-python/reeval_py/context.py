"""Attempt context: sends attempt-protocol requests to reeval over the runner socket."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Awaitable

SendFn = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class AttemptContext:
    def __init__(self, attempt_id: str, send: SendFn) -> None:
        self._attempt = attempt_id
        self._send = send
        self._seq = 0
        self.turns: list[dict[str, Any]] = []

    async def _call(self, op: str, **fields: Any) -> dict[str, Any]:
        self._seq += 1
        call: dict[str, Any] = {"op": op, **fields}
        reply = await self._send({"call": call})
        if not reply.get("ok", False):
            err = reply.get("error") or {"name": "Error", "message": "call failed"}
            raise RuntimeError(f"{err.get('name')}: {err.get('message')}")
        return reply

    async def send(self, prompt: str) -> dict[str, Any]:
        reply = await self._call("send", prompt=prompt)
        turn = reply["turn"]
        self.turns.append(turn)
        return turn

    async def exec(self, command: str) -> dict[str, Any]:
        reply = await self._call("exec", command=command)
        return reply["result"]

    async def read_file(self, path: str) -> str | None:
        reply = await self._call("readFile", path=path)
        return reply.get("contents")

    async def expect(
        self,
        subject: dict[str, Any],
        matcher: str,
        args: list[Any] | None = None,
        *,
        label: str | None = None,
        not_: bool = False,
        soft: bool = False,
    ) -> None:
        call: dict[str, Any] = {
            "op": "expect",
            "subject": subject,
            "matcher": matcher,
            "args": args or [],
            "not": not_,
            "soft": soft,
        }
        if label is not None:
            call["label"] = label
        reply = await self._send({"call": call})
        if not reply.get("ok", False):
            err = reply.get("error") or {"name": "Error", "message": "call failed"}
            raise RuntimeError(f"{err.get('name')}: {err.get('message')}")
        assertion = reply.get("assertion") or {}
        if assertion.get("status") == "fail":
            msg = assertion.get("message") or "expect failed"
            raise AssertionError(msg)

    async def judge(self, question: str, **options: Any) -> dict[str, Any]:
        reply = await self._call("judge", question=question, options=options or None)
        return reply["verdict"]
