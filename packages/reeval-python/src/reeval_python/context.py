"""Attempt context: native Python API over the attempt protocol."""

from __future__ import annotations

import base64
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any, cast

from reeval_python.assertion import assert_to_expect
from reeval_python.errors import ReevalAssertionError
from reeval_python.expect import bind_expect
from reeval_python.types import BackgroundHandle, ExecResult, Turn, Verdict
from reeval_python.wire import options_to_wire

SendFn = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class AttemptContext:
    def __init__(self, attempt_id: str, send: SendFn) -> None:
        self._attempt = attempt_id
        self._send = send
        self._seq = 0
        self.turns: list[Turn] = []

    async def _call(self, op: str, **fields: Any) -> dict[str, Any]:
        self._seq += 1
        call: dict[str, Any] = {"op": op, **fields}
        reply = await self._send({"call": call})
        if not reply.get("ok", False):
            err = reply.get("error") or {"name": "Error", "message": "call failed"}
            raise RuntimeError(f"{err.get('name')}: {err.get('message')}")
        return reply

    async def send(self, prompt: str) -> Turn:
        reply = await self._call("send", prompt=prompt)
        turn = Turn(index=len(self.turns), raw=cast(dict[str, Any], reply["turn"]))
        self.turns.append(turn)
        return turn

    async def exec(
        self,
        command: str,
        *,
        background: bool = False,
    ) -> ExecResult | BackgroundHandle:
        fields: dict[str, Any] = {"command": command}
        if background:
            fields["background"] = True
        reply = await self._call("exec", **fields)
        result = cast(dict[str, Any], reply["result"])
        if background:
            return BackgroundHandle.from_wire(result)
        return ExecResult.from_wire(command, result)

    async def read_file(self, path: str) -> str | None:
        reply = await self._call("readFile", path=path)
        contents = reply.get("contents")
        return None if contents is None else str(contents)

    async def file(self, path: str) -> str | None:
        return await self.read_file(path)

    async def write_file(self, path: str, contents: str | bytes) -> None:
        if isinstance(contents, bytes):
            encoded = base64.b64encode(contents).decode()
            await self._call("writeFile", path=path, contents=encoded, encoding="base64")
        else:
            await self._call("writeFile", path=path, contents=contents)

    async def kill(self, handle: BackgroundHandle) -> None:
        await self._call("kill", handle=handle.id)

    async def judge(self, question: str, **options: Any) -> Verdict:
        wire_opts = options_to_wire(options)
        fields: dict[str, Any] = {"options": wire_opts} if wire_opts else {}
        reply = await self._call("judge", question=question, **fields)
        return Verdict.from_wire(cast(dict[str, Any], reply["verdict"]))

    async def run_expect(
        self,
        *,
        subject: dict[str, Any],
        matcher: str,
        args: list[Any],
        label: str | None,
        not_: bool,
        soft: bool,
    ) -> None:
        call: dict[str, Any] = {
            "op": "expect",
            "subject": subject,
            "matcher": matcher,
            "args": args,
            "not": not_,
            "soft": soft,
        }
        if label is not None:
            call["label"] = label
        reply = await self._send({"call": call})
        if not reply.get("ok", False):
            err = reply.get("error") or {"name": "Error", "message": "call failed"}
            raise RuntimeError(f"{err.get('name')}: {err.get('message')}")
        assertion_raw = reply.get("assertion")
        assertion = cast(dict[str, Any], assertion_raw) if isinstance(assertion_raw, dict) else {}
        if assertion.get("status") == "fail" and not soft:
            raise ReevalAssertionError(str(assertion.get("message") or "expect failed"))

    async def record_plain_assert(self, exc: AssertionError) -> None:
        wire = assert_to_expect(exc)
        await self.run_expect(
            subject=wire.subject,
            matcher=wire.matcher,
            args=wire.args,
            label=wire.label,
            not_=wire.not_,
            soft=False,
        )

    def bind_expect(self) -> None:
        async def submit(**kwargs: Any) -> None:
            await self.run_expect(**kwargs)

        submit._sync_mode = False  # type: ignore[attr-defined]
        bind_expect(submit)


class SyncAttemptContext:
    """Sync façade: each method blocks on the runner's asyncio loop."""

    def __init__(self, async_ctx: AttemptContext, loop: Any) -> None:
        self._ctx = async_ctx
        self._loop = loop

    def _run(self, coro: Coroutine[Any, Any, Any]) -> Any:
        import asyncio

        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return fut.result()

    def send(self, prompt: str) -> Turn:
        return self._run(self._ctx.send(prompt))

    def exec(self, command: str, *, background: bool = False) -> ExecResult | BackgroundHandle:
        return cast(
            ExecResult | BackgroundHandle,
            self._run(self._ctx.exec(command, background=background)),  # type: ignore[arg-type]
        )

    def read_file(self, path: str) -> str | None:
        return self._run(self._ctx.read_file(path))

    def file(self, path: str) -> str | None:
        return self._run(self._ctx.file(path))

    def write_file(self, path: str, contents: str | bytes) -> None:
        self._run(self._ctx.write_file(path, contents))

    def kill(self, handle: BackgroundHandle) -> None:
        self._run(self._ctx.kill(handle))

    def judge(self, question: str, **options: Any) -> Verdict:
        return self._run(self._ctx.judge(question, **options))

    def bind_expect(self) -> None:
        def submit(**kwargs: Any) -> None:
            self._run(self._ctx.run_expect(**kwargs))

        submit._sync_mode = True  # type: ignore[attr-defined]
        bind_expect(submit)
