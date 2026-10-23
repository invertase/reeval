"""Attempt context: native Python API over the attempt protocol."""

from __future__ import annotations

import asyncio
import base64
import inspect
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
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
from reeval_python.wire import Patterns, json_value, options_to_wire, wire_args

_UNSET: Any = object()

SendFn = Callable[[AttemptCall], Awaitable[dict[str, Any]]]

# Set while `expect.poll` calls its function: reads and commands are described, not made, so
# reeval can make them again on each try.
_describing: ContextVar[bool] = ContextVar("_describing", default=False)


class Described:
    """What `c.read_file(…)` or `c.exec(…)` names inside `expect.poll`'s function."""

    def __init__(self, subject: MatcherSubject) -> None:
        self.subject = subject


def describe(fn: Callable[[], object]) -> MatcherSubject:
    """The read or command `fn` makes, for `expect.poll` to repeat."""
    token = _describing.set(True)
    try:
        out = fn()
    finally:
        _describing.reset(token)
    if isinstance(out, Described):
        return out.subject
    if inspect.iscoroutine(out):
        out.close()
    raise TypeError(
        "expect.poll's function must return c.read_file(…) or c.exec(…), which reeval reads "
        "or runs again on each try"
    )


def _not_describing(what: str) -> None:
    if _describing.get():
        raise TypeError(f"expect.poll's function can only read a file or run a command, not {what}")


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
        _not_describing("c.send")
        reply = await self._call({"op": "send", "prompt": prompt})
        turn = Turn(index=len(self.turns), raw=cast(dict[str, Any], reply["turn"]))
        self.turns.append(turn)
        return turn

    @overload
    def exec(self, command: str) -> Coroutine[Any, Any, ExecResult]: ...
    @overload
    def exec(
        self, command: str, *, background: Literal[True]
    ) -> Coroutine[Any, Any, BackgroundHandle]: ...
    @overload
    def exec(
        self, command: str, *, background: bool
    ) -> Coroutine[Any, Any, ExecResult | BackgroundHandle]: ...

    def exec(
        self, command: str, *, background: bool = False
    ) -> Coroutine[Any, Any, ExecResult | BackgroundHandle]:
        """Run a command in the sandbox; with `background=True`, leave it running."""
        if _describing.get() and not background:
            return cast(Any, Described({"exec": command}))
        _not_describing("c.exec(…, background=True)")
        return self._exec(command, background)

    async def _exec(self, command: str, background: bool) -> ExecResult | BackgroundHandle:
        call: AttemptCallExec = {"op": "exec", "command": command}
        if background:
            call["background"] = True
        result = cast(dict[str, Any], (await self._call(call))["result"])
        return (
            BackgroundHandle.from_wire(result)
            if background
            else ExecResult.from_wire(command, result)
        )

    def read_file(self, path: str) -> Coroutine[Any, Any, str | None]:
        """A file's contents in the sandbox, or `None` when there's no such file."""
        if _describing.get():
            return cast(Any, Described({"readFile": path}))
        return self._read_file(path)

    async def _read_file(self, path: str) -> str | None:
        contents = (await self._call({"op": "readFile", "path": path})).get("contents")
        return None if contents is None else str(contents)

    def file(self, path: str) -> Coroutine[Any, Any, str | None]:
        return self.read_file(path)

    async def write_file(self, path: str, contents: str | bytes) -> None:
        _not_describing("c.write_file")
        if isinstance(contents, bytes):
            encoded = base64.b64encode(contents).decode()
            await self._call(
                {"op": "writeFile", "path": path, "contents": encoded, "encoding": "base64"}
            )
        else:
            await self._call({"op": "writeFile", "path": path, "contents": contents})

    async def kill(self, handle: BackgroundHandle) -> None:
        _not_describing("c.kill")
        await self._call({"op": "kill", "handle": handle.id})

    async def judge(self, question: str, *, on: Any = _UNSET, **options: Any) -> Verdict:
        """Ask the judge a yes/no question about the latest turn, or `on` an earlier turn or
        a value: an `ExecResult`, a `Verdict` or any JSON value, `None` included."""
        _not_describing("c.judge")
        wire_opts = options_to_wire(options) or {}
        if on is not _UNSET:
            accepted = "judge(on=…) takes a turn, an ExecResult, a Verdict or a JSON value"
            wire_opts["on"] = (
                {"turn": on.index} if isinstance(on, Turn) else {"value": json_value(on, accepted)}
            )
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
        _not_describing("c.send")
        return self._run(self._ctx.send(prompt))

    @overload
    def exec(self, command: str) -> ExecResult: ...
    @overload
    def exec(self, command: str, *, background: Literal[True]) -> BackgroundHandle: ...
    @overload
    def exec(self, command: str, *, background: bool) -> ExecResult | BackgroundHandle: ...

    def exec(self, command: str, *, background: bool = False) -> ExecResult | BackgroundHandle:
        """Run a command in the sandbox and wait for it; with `background=True`, leave it
        running."""
        if _describing.get() and not background:
            return cast(Any, Described({"exec": command}))
        _not_describing("c.exec(…, background=True)")
        return self._run(self._ctx.exec(command, background=background))

    def read_file(self, path: str) -> str | None:
        """A file's contents in the sandbox, or `None` when there's no such file."""
        if _describing.get():
            return cast(Any, Described({"readFile": path}))
        return self._run(self._ctx.read_file(path))

    def file(self, path: str) -> str | None:
        return self.read_file(path)

    def write_file(self, path: str, contents: str | bytes) -> None:
        _not_describing("c.write_file")
        self._run(self._ctx.write_file(path, contents))

    def kill(self, handle: BackgroundHandle) -> None:
        _not_describing("c.kill")
        self._run(self._ctx.kill(handle))

    def judge(self, question: str, *, on: Any = _UNSET, **options: Any) -> Verdict:
        _not_describing("c.judge")
        return self._run(self._ctx.judge(question, on=on, **options))

    def bind_expect(self) -> None:
        def submit(**kwargs: Any) -> None:
            self._run(self._ctx.run_expect(**kwargs))

        submit._sync_mode = True  # type: ignore[attr-defined]
        bind_expect(submit)
