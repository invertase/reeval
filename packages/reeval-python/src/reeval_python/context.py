"""Attempt context: native Python API over the attempt protocol."""

from __future__ import annotations

import asyncio
import base64
import inspect
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
from datetime import timedelta
from typing import Any, Literal, NoReturn, Unpack, cast, overload

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
from reeval_python.expect import bind_expect, tracked
from reeval_python.options import JUDGE_INPUTS, JudgeOptions
from reeval_python.types import BackgroundHandle, ExecResult, Turn, Verdict
from reeval_python.wire import Patterns, json_value, options_to_wire, seconds, wire_args

_UNSET: Any = object()

NO_JUDGE_INPUT = (
    "c.judge() shows the judge nothing: turn on at least one input, such as diff=True or "
    "contents=['src/**']. The inputs are "
    + ", ".join(JUDGE_INPUTS[:-1])
    + f" or {JUDGE_INPUTS[-1]}."
)


def _input_on(value: object) -> bool:
    return (
        value is not None
        and value is not False
        and not (isinstance(value, (list, tuple)) and not value)
    )


def _shows_something(options: JudgeOptions) -> None:
    """Refuses a call that turns no input on, before it reaches reeval or a model."""
    if not any(_input_on(options.get(key)) for key in JUDGE_INPUTS):
        raise TypeError(NO_JUDGE_INPUT)


SendFn = Callable[[AttemptCall], Awaitable[dict[str, Any]]]

# Set while `expect.poll` calls its function: reads and commands are described, not made, so
# reeval can make them again on each try. Holds each one the function described.
_describing: ContextVar[list[MatcherSubject] | None] = ContextVar("_describing", default=None)

_RETURN_IT = (
    "expect.poll's function returns c.read_file(…) or c.exec(…) itself, which reeval reads or "
    "runs again on each try: check its contents or output with a matcher, as in "
    "expect.poll(lambda: c.exec('cat x')).to_contain('ok')"
)


class Described:
    """What `c.read_file(…)` or `c.exec(…)` names inside `expect.poll`'s function: nothing to
    read or compare yet, since reeval makes the call on each try."""

    __slots__ = ("_subject",)

    def __init__(self, subject: MatcherSubject) -> None:
        object.__setattr__(self, "_subject", subject)
        described = _describing.get()
        if described is not None:
            described.append(subject)

    def __getattr__(self, name: str) -> NoReturn:
        raise TypeError(f"{_RETURN_IT} (it read .{name})")

    def __bool__(self) -> NoReturn:
        raise TypeError(_RETURN_IT)

    def __eq__(self, other: object) -> NoReturn:
        raise TypeError(_RETURN_IT)

    __hash__ = None  # type: ignore[assignment]


def describe(fn: Callable[[], object]) -> MatcherSubject:
    """The read or command `fn` makes, for `expect.poll` to repeat."""
    try:
        inspect.signature(fn).bind()
    except TypeError:
        raise TypeError(
            "expect.poll's function takes no arguments, e.g. "
            "expect.poll(lambda: c.read_file('ready.txt'))"
        ) from None
    except ValueError:
        pass
    described: list[MatcherSubject] = []
    token = _describing.set(described)
    try:
        out = fn()
    finally:
        _describing.reset(token)
    if len(described) > 1:
        raise TypeError(
            "expect.poll's function reads one file or runs one command, which reeval makes again "
            f"on each try; this one made {len(described)}"
        )
    if isinstance(out, Described):
        return out._subject  # pyright: ignore[reportPrivateUsage]
    if inspect.iscoroutine(out):
        out.close()
    raise TypeError(
        "expect.poll's function must return c.read_file(…) or c.exec(…), which reeval reads "
        "or runs again on each try"
    )


def _not_describing(what: str) -> None:
    if _describing.get() is not None:
        raise TypeError(f"expect.poll's function can only read a file or run a command, not {what}")


def _no_poll_retries(retries: int | None, interval: timedelta | float | None) -> None:
    if retries is not None or interval is not None:
        raise TypeError(
            "expect.poll runs its command again on each try already: drop c.exec's retries and "
            "interval, or check the command once, without expect.poll"
        )


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

    def send(self, prompt: str) -> Coroutine[Any, Any, Turn]:
        """Send the agent a prompt and wait for its turn to end."""
        _not_describing("c.send")
        return tracked(self._send_turn(prompt), "c.send()")

    async def _send_turn(self, prompt: str) -> Turn:
        reply = await self._call({"op": "send", "prompt": prompt})
        turn = Turn._from_wire(len(self.turns), cast(dict[str, Any], reply["turn"]))  # pyright: ignore[reportPrivateUsage]
        self.turns.append(turn)
        return turn

    @overload
    def exec(
        self, command: str, *, retries: int | None = None, interval: timedelta | float | None = None
    ) -> Coroutine[Any, Any, ExecResult]: ...
    @overload
    def exec(
        self, command: str, *, background: Literal[True]
    ) -> Coroutine[Any, Any, BackgroundHandle]: ...
    @overload
    def exec(
        self,
        command: str,
        *,
        background: bool,
        retries: int | None = None,
        interval: timedelta | float | None = None,
    ) -> Coroutine[Any, Any, ExecResult | BackgroundHandle]: ...

    def exec(
        self,
        command: str,
        *,
        background: bool = False,
        retries: int | None = None,
        interval: timedelta | float | None = None,
    ) -> Coroutine[Any, Any, ExecResult | BackgroundHandle]:
        """Run a command in the sandbox; with `background=True`, leave it running. With
        `retries`, a non-zero exit runs it again, up to that many extra times, `interval`
        apart (seconds or a timedelta, default 1 second), and it returns the last try."""
        if _describing.get() is not None and not background:
            _no_poll_retries(retries, interval)
            return cast(Any, Described({"exec": command}))
        _not_describing("c.exec(…, background=True)")
        return tracked(self._exec(command, background, retries, interval), "c.exec()")

    async def _exec(
        self,
        command: str,
        background: bool,
        retries: int | None,
        interval: timedelta | float | None,
    ) -> ExecResult | BackgroundHandle:
        call: AttemptCallExec = {"op": "exec", "command": command}
        if background:
            call["background"] = True
        if retries is not None:
            call["retries"] = retries
        if interval is not None:
            ms = seconds(interval, "c.exec(interval=…)") * 1000
            if ms < 0:
                raise ValueError(f"c.exec(interval=…) takes 0 or more seconds (got {interval!r})")
            call["interval"] = int(ms) if ms == int(ms) else ms
        result = cast(dict[str, Any], (await self._call(call))["result"])
        return (
            BackgroundHandle._from_wire(result)  # pyright: ignore[reportPrivateUsage]
            if background
            else ExecResult._from_wire(command, result)  # pyright: ignore[reportPrivateUsage]
        )

    def read_file(self, path: str) -> Coroutine[Any, Any, str | None]:
        """A file's contents in the sandbox, or `None` when there's no such file."""
        if _describing.get() is not None:
            return cast(Any, Described({"readFile": path}))
        return tracked(self._read_file(path), "c.read_file()")

    async def _read_file(self, path: str) -> str | None:
        contents = (await self._call({"op": "readFile", "path": path})).get("contents")
        return None if contents is None else str(contents)

    def file(self, path: str) -> Coroutine[Any, Any, str | None]:
        return self.read_file(path)

    def write_file(self, path: str, contents: str | bytes) -> Coroutine[Any, Any, None]:
        """Write a file in the sandbox's workspace."""
        _not_describing("c.write_file")
        return tracked(self._write_file(path, contents), "c.write_file()")

    async def _write_file(self, path: str, contents: str | bytes) -> None:
        if isinstance(contents, bytes):
            encoded = base64.b64encode(contents).decode()
            await self._call(
                {"op": "writeFile", "path": path, "contents": encoded, "encoding": "base64"}
            )
        else:
            await self._call({"op": "writeFile", "path": path, "contents": contents})

    def kill(self, handle: BackgroundHandle) -> Coroutine[Any, Any, None]:
        """Stop a command `c.exec(…, background=True)` left running."""
        _not_describing("c.kill")
        return tracked(self._kill(handle), "c.kill()")

    async def _kill(self, handle: BackgroundHandle) -> None:
        await self._call({"op": "kill", "handle": handle.id})

    def judge(
        self, question: str, *, on: object = _UNSET, **options: Unpack[JudgeOptions]
    ) -> Coroutine[Any, Any, Verdict]:
        """Ask the judge a yes/no question about the latest turn, or `on` an earlier turn or
        a value: an `ExecResult`, a `Verdict` or any JSON value, `None` included. It's shown only
        the inputs the call turns on, at least one: `c.judge("…", diff=True)`."""
        _not_describing("c.judge")
        _shows_something(options)
        return tracked(self._judge(question, on, dict(options)), "c.judge()")

    async def _judge(self, question: str, on: object, options: dict[str, Any]) -> Verdict:
        wire_opts = options_to_wire(options) or {}
        if on is not _UNSET:
            accepted = "judge(on=…) takes a turn, an ExecResult, a Verdict or a JSON value"
            wire_opts["on"] = (
                {"turn": on.index} if isinstance(on, Turn) else {"value": json_value(on, accepted)}
            )
        call: AttemptCallJudge = {
            "op": "judge",
            "question": question,
            "options": cast(JudgeCallData, wire_opts),
        }
        reply = await self._call(call)
        return Verdict._from_wire(cast(dict[str, Any], reply["verdict"]))  # pyright: ignore[reportPrivateUsage]

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
        """Send the agent a prompt and wait for its turn to end."""
        _not_describing("c.send")
        return self._run(self._ctx._send_turn(prompt))  # pyright: ignore[reportPrivateUsage]

    @overload
    def exec(
        self, command: str, *, retries: int | None = None, interval: timedelta | float | None = None
    ) -> ExecResult: ...
    @overload
    def exec(self, command: str, *, background: Literal[True]) -> BackgroundHandle: ...
    @overload
    def exec(
        self,
        command: str,
        *,
        background: bool,
        retries: int | None = None,
        interval: timedelta | float | None = None,
    ) -> ExecResult | BackgroundHandle: ...

    def exec(
        self,
        command: str,
        *,
        background: bool = False,
        retries: int | None = None,
        interval: timedelta | float | None = None,
    ) -> ExecResult | BackgroundHandle:
        """Run a command in the sandbox and wait for it; with `background=True`, leave it
        running. With `retries`, a non-zero exit runs it again, up to that many extra times,
        `interval` apart (seconds or a timedelta, default 1 second), and it returns the last
        try."""
        if _describing.get() is not None and not background:
            _no_poll_retries(retries, interval)
            return cast(Any, Described({"exec": command}))
        _not_describing("c.exec(…, background=True)")
        return self._run(self._ctx._exec(command, background, retries, interval))  # pyright: ignore[reportPrivateUsage]

    def read_file(self, path: str) -> str | None:
        """A file's contents in the sandbox, or `None` when there's no such file."""
        if _describing.get() is not None:
            return cast(Any, Described({"readFile": path}))
        return self._run(self._ctx._read_file(path))  # pyright: ignore[reportPrivateUsage]

    def file(self, path: str) -> str | None:
        return self.read_file(path)

    def write_file(self, path: str, contents: str | bytes) -> None:
        """Write a file in the sandbox's workspace."""
        _not_describing("c.write_file")
        self._run(self._ctx._write_file(path, contents))  # pyright: ignore[reportPrivateUsage]

    def kill(self, handle: BackgroundHandle) -> None:
        """Stop a command `c.exec(…, background=True)` left running."""
        _not_describing("c.kill")
        self._run(self._ctx._kill(handle))  # pyright: ignore[reportPrivateUsage]

    def judge(
        self, question: str, *, on: object = _UNSET, **options: Unpack[JudgeOptions]
    ) -> Verdict:
        """Ask the judge a yes/no question about the latest turn, or `on` an earlier turn or
        a value: an `ExecResult`, a `Verdict` or any JSON value, `None` included. It's shown only
        the inputs the call turns on, at least one: `c.judge("…", diff=True)`."""
        _not_describing("c.judge")
        _shows_something(options)
        return self._run(self._ctx._judge(question, on, dict(options)))  # pyright: ignore[reportPrivateUsage]

    def bind_expect(self) -> None:
        def submit(**kwargs: Any) -> None:
            self._run(self._ctx.run_expect(**kwargs))

        submit._sync_mode = True  # type: ignore[attr-defined]
        bind_expect(submit)
