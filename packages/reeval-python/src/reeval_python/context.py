"""Attempt context: native Python API over the attempt protocol."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable, Coroutine, Generator
from typing import Any, Literal, cast, overload

from reeval_python._wire import (
    AttemptCall,
    AttemptCallExec,
    AttemptCallExpect,
    AttemptCallExpectPoll,
    AttemptCallJudge,
    JudgeCallData,
    MatcherSubject,
)
from reeval_python.errors import ReevalAssertionError, ReevalCallError
from reeval_python.expect import bind_expect
from reeval_python.types import BackgroundHandle, ExecResult, Turn, Verdict
from reeval_python.wire import Patterns, options_to_wire, wire_args

SendFn = Callable[[AttemptCall], Awaitable[dict[str, Any]]]
CallFn = SendFn


class PendingExec:
    """`c.exec(command)` before it's awaited: `await` it for its result, or hand it to `expect`,
    which runs it (once per poll) and names the check by its command."""

    def __init__(self, call: CallFn, command: str) -> None:
        self._call = call
        self.command = command

    async def result(self) -> ExecResult:
        reply = await self._call({"op": "exec", "command": self.command})
        return ExecResult.from_wire(self.command, cast(dict[str, Any], reply["result"]))

    def __await__(self) -> Generator[Any, None, ExecResult]:
        return self.result().__await__()


class PendingRead:
    """`c.read_file(path)` before it's awaited: `await` it for the contents (`None` when there's
    no file), or hand it to `expect`, which reads it (once per poll)."""

    def __init__(self, call: CallFn, path: str) -> None:
        self._call = call
        self.path = path

    async def result(self) -> str | None:
        reply = await self._call({"op": "readFile", "path": self.path})
        contents = reply.get("contents")
        return None if contents is None else str(contents)

    def __await__(self) -> Generator[Any, None, str | None]:
        return self.result().__await__()


PATTERN_ROUNDS = 5


class AttemptContext:
    def __init__(self, attempt_id: str, send: SendFn) -> None:
        self._attempt = attempt_id
        self._send = send
        self.turns: list[Turn] = []

    async def _call(self, call: AttemptCall) -> dict[str, Any]:
        reply = await self._send(call)
        if not reply.get("ok", False):
            err = cast(dict[str, Any], reply.get("error") or {})
            raise ReevalCallError(str(err.get("name", "Error")), str(err.get("message", "")))
        return reply

    async def send(self, prompt: str) -> Turn:
        reply = await self._call({"op": "send", "prompt": prompt})
        turn = Turn(index=len(self.turns), raw=cast(dict[str, Any], reply["turn"]))
        self.turns.append(turn)
        return turn

    @overload
    def exec(self, command: str) -> PendingExec: ...
    @overload
    def exec(
        self, command: str, *, background: Literal[True]
    ) -> Coroutine[Any, Any, BackgroundHandle]: ...

    def exec(
        self, command: str, *, background: bool = False
    ) -> PendingExec | Coroutine[Any, Any, BackgroundHandle]:
        """Run a command in the sandbox; with `background=True`, leave it running."""
        if background:
            return self._background(command)
        return PendingExec(self._call, command)

    async def _background(self, command: str) -> BackgroundHandle:
        call: AttemptCallExec = {"op": "exec", "command": command, "background": True}
        reply = await self._call(call)
        return BackgroundHandle.from_wire(cast(dict[str, Any], reply["result"]))

    def read_file(self, path: str) -> PendingRead:
        return PendingRead(self._call, path)

    def file(self, path: str) -> PendingRead:
        return self.read_file(path)

    async def write_file(self, path: str, contents: str | bytes) -> None:
        if isinstance(contents, bytes):
            encoded = base64.b64encode(contents).decode()
            await self._call(
                {"op": "writeFile", "path": path, "contents": encoded, "encoding": "base64"}
            )
        else:
            await self._call({"op": "writeFile", "path": path, "contents": contents})

    async def kill(self, handle: BackgroundHandle) -> None:
        await self._call({"op": "kill", "handle": handle.id})

    async def judge(self, question: str, *, on: Any = None, **options: Any) -> Verdict:
        """Ask the judge a yes/no question about the latest turn, or `on` an earlier turn or
        a value."""
        wire_opts = options_to_wire(options) or {}
        if on is not None:
            wire_opts["on"] = {"turn": on.index} if isinstance(on, Turn) else {"value": on}
        call: AttemptCallJudge = {"op": "judge", "question": question}
        if wire_opts:
            call["options"] = cast(JudgeCallData, wire_opts)
        reply = await self._call(call)
        return Verdict.from_wire(cast(dict[str, Any], reply["verdict"]))

    async def run_expect(
        self,
        *,
        subject: MatcherSubject,
        matcher: str,
        args: list[Any],
        label: str | None,
        not_: bool,
        soft: bool,
        poll: AttemptCallExpectPoll | None = None,
    ) -> None:
        patterns = Patterns()
        call: AttemptCallExpect = {
            "op": "expect",
            "subject": subject,
            "matcher": matcher,
            "args": wire_args(args, patterns),
            "not": not_,
            "soft": soft,
        }
        if label is not None:
            call["label"] = label
        if poll is not None:
            call["poll"] = {**poll}
        reply = await self._call(call)
        # reeval asks for the strings it tested the patterns on; each round answers more. A
        # subject that changes on every read never runs out of new strings, so the rounds stop.
        # A pattern is answered off the event loop, where a slow one can't hold up other bodies.
        for _ in range(PATTERN_ROUNDS):
            if "untested" not in reply:
                break
            untested = cast(dict[str, list[str]], reply["untested"])
            await asyncio.to_thread(patterns.answer, untested)
            reply = await self._call(call)
        else:
            if "untested" in reply:
                names = ", ".join(cast(dict[str, Any], reply["untested"]))
                raise RuntimeError(
                    f"UsageError: {matcher}'s subject changed while reeval matched {names} on it, "
                    f"{PATTERN_ROUNDS} times over: check it once it has stopped changing"
                )
        assertion = cast(dict[str, Any], reply.get("assertion") or {})
        if assertion.get("status") == "fail" and not soft:
            raise ReevalAssertionError(str(assertion.get("message") or "expect failed"))

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

    @property
    def turns(self) -> list[Turn]:
        return self._ctx.turns

    def _run(self, coro: Coroutine[Any, Any, Any]) -> Any:
        import asyncio

        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return fut.result()

    def send(self, prompt: str) -> Turn:
        return self._run(self._ctx.send(prompt))

    @overload
    def exec(self, command: str) -> ExecResult: ...
    @overload
    def exec(self, command: str, *, background: Literal[True]) -> BackgroundHandle: ...

    def exec(self, command: str, *, background: bool = False) -> ExecResult | BackgroundHandle:
        if background:
            return self._run(self._ctx.exec(command, background=True))
        return self._run(self._ctx.exec(command).result())

    def read_file(self, path: str) -> str | None:
        return self._run(self._ctx.read_file(path).result())

    def file(self, path: str) -> str | None:
        return self.read_file(path)

    def write_file(self, path: str, contents: str | bytes) -> None:
        self._run(self._ctx.write_file(path, contents))

    def kill(self, handle: BackgroundHandle) -> None:
        self._run(self._ctx.kill(handle))

    def judge(self, question: str, *, on: Any = None, **options: Any) -> Verdict:
        return self._run(self._ctx.judge(question, on=on, **options))

    def bind_expect(self) -> None:
        def submit(**kwargs: Any) -> None:
            self._run(self._ctx.run_expect(**kwargs))

        submit._sync_mode = True  # type: ignore[attr-defined]
        bind_expect(submit)
