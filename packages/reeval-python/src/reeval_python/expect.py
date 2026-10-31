"""`expect` for `def` bodies: reeval's matchers, with snake_case names, each a blocking call.

`reeval_python.aio.expect` is the same for `async def` bodies, where each matcher is awaited.
reeval runs the matcher on what the eval hands it and records the check. A failed `expect`
fails the attempt and the body carries on; `expect.require` raises, ending the body there.
"""

from __future__ import annotations

import itertools
import os
import re
import sys
from collections.abc import Callable, Coroutine, Mapping, Sequence
from contextvars import ContextVar
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Generic, Self, TypeVar

from reeval_python._wire import AttemptCallExpectAt, AttemptCallExpectPoll, MatcherSubject
from reeval_python.wire import seconds, subject_for_matcher

if TYPE_CHECKING:
    from reeval_python.context import AttemptContext, SyncAttemptContext

SubmitFn = Any

_submit: ContextVar[SubmitFn | None] = ContextVar("_submit", default=None)

# An async body's calls and matchers not awaited yet: each one's name, and how to close it.
# The runner fails a body that leaves any, since what wasn't awaited never ran.
_unawaited: ContextVar[dict[int, tuple[str, Callable[[], None]]] | None] = ContextVar(
    "_unawaited", default=None
)

_tokens = itertools.count()

R = TypeVar("R")
T = TypeVar("T")

Pattern = str | re.Pattern[str] | re.Pattern[bytes]
ToolInput = str | re.Pattern[str] | re.Pattern[bytes] | dict[str, Any]

_UNSET: Any = object()


def bind_expect(submit: SubmitFn) -> None:
    _submit.set(submit)
    _unawaited.set({})


def tracked(coro: Coroutine[Any, Any, T], name: str) -> Coroutine[Any, Any, T]:
    """`coro`, noted as not yet run until it's first awaited (or a task starts it)."""
    pending = _unawaited.get()
    if pending is None:
        return coro
    token = next(_tokens)

    async def run() -> T:
        pending.pop(token, None)
        return await coro

    wrapper = run()

    def close() -> None:
        wrapper.close()
        coro.close()

    pending[token] = (name, close)
    return wrapper


def unawaited() -> list[str]:
    """The body's calls and matchers it never awaited, closed so Python doesn't warn too."""
    pending = _unawaited.get() or {}
    names = [name for name, _ in pending.values()]
    for _, close in pending.values():
        close()
    pending.clear()
    return names


def _bound(what: str, sync: bool) -> SubmitFn:
    submit = _submit.get()
    if submit is None:
        raise RuntimeError(f"{what} must run inside an eval body")
    if bool(getattr(submit, "_sync_mode", False)) != sync:
        if sync:
            raise RuntimeError(
                f"{what} is for def bodies; in an async def body, use reeval_python.aio's and "
                "await the matcher"
            )
        raise RuntimeError(
            f"{what} is reeval_python.aio's, for async def bodies; use "
            "reeval_python's in a def body"
        )
    return submit


_PACKAGE = os.path.dirname(os.path.abspath(__file__)) + os.sep


def call_site(depth: int = 1) -> AttemptCallExpectAt | None:
    """Where the eval made the call: its frame in a `.eval.py` file, as a helper in another file
    is called from one, else the first frame outside reeval_python."""
    frame = sys._getframe(depth)  # pyright: ignore[reportPrivateUsage]
    first: AttemptCallExpectAt | None = None
    while frame is not None:
        name = frame.f_code.co_filename
        file = os.path.abspath(name)
        if not file.startswith(_PACKAGE) and not name.startswith("<"):
            if file.endswith(".eval.py"):
                return {"file": file, "line": frame.f_lineno}
            first = first or {"file": file, "line": frame.f_lineno}
        frame = frame.f_back
    return first


def _given(*args: Any) -> list[Any]:
    """A matcher's arguments up to the first one left out, as reeval reads them."""
    out: list[Any] = []
    for arg in args:
        if arg is _UNSET:
            break
        out.append(arg)
    return out


class _Matchers(Generic[R]):
    """reeval's matchers on one subject. `R` is what a matcher returns: `None` in a `def` body,
    a coroutine to await in an `async def` body."""

    def __init__(
        self,
        subject: MatcherSubject,
        submit: SubmitFn,
        *,
        label: str | None = None,
        not_: bool = False,
        soft: bool = True,
        poll: AttemptCallExpectPoll | None = None,
    ) -> None:
        self._subject = subject
        self._submit = submit
        self._label = label
        self._not = not_
        self._soft = soft
        self._poll = poll

    @property
    def not_(self) -> Self:
        """The matcher that follows passes when it would fail."""
        return type(self)(
            self._subject,
            self._submit,
            label=self._label,
            not_=not self._not,
            soft=self._soft,
            poll=self._poll,
        )

    def _match(self, matcher: str, args: list[Any]) -> R:
        raise NotImplementedError

    def _fields(self, matcher: str, args: list[Any]) -> dict[str, Any]:
        fields: dict[str, Any] = {
            "subject": self._subject,
            "matcher": matcher,
            "args": args,
            "label": self._label,
            "not_": self._not,
            "soft": self._soft,
        }
        if self._poll is not None:
            fields["poll"] = self._poll
        at = call_site()
        if at is not None:
            fields["at"] = at
        return fields

    def to_be(self, expected: Any) -> R:
        return self._match("toBe", [expected])

    def to_equal(self, expected: Any) -> R:
        return self._match("toEqual", [expected])

    def to_be_null(self) -> R:
        return self._match("toBeNull", [])

    def to_be_truthy(self) -> R:
        return self._match("toBeTruthy", [])

    def to_contain(self, needle: Any) -> R:
        return self._match("toContain", [needle])

    def to_have_file(self, path: str, pattern: Pattern = _UNSET) -> R:
        """The workspace has the file, with contents matching `pattern` when it's given."""
        return self._match("toHaveFile", _given(path, pattern))

    def to_succeed(self) -> R:
        """The command exits 0."""
        return self._match("toSucceed", [])

    def to_have_searched(self, query: Pattern = _UNSET) -> R:
        return self._match("toHaveSearched", _given(query))

    def to_have_fetched(self, url: Pattern = _UNSET) -> R:
        return self._match("toHaveFetched", _given(url))

    def to_have_called_skill(self, name: str) -> R:
        return self._match("toHaveCalledSkill", [name])

    def to_have_called_mcp(self, server: str, tool: str, input: ToolInput = _UNSET) -> R:  # noqa: A002
        return self._match("toHaveCalledMcp", _given(server, tool, input))

    def to_have_called_tool(self, name: Pattern, input: ToolInput = _UNSET) -> R:  # noqa: A002
        return self._match("toHaveCalledTool", _given(name, input))

    def to_have_run(self, command: Pattern = _UNSET) -> R:
        return self._match("toHaveRun", _given(command))

    def to_have_edited(self, path: Pattern = _UNSET) -> R:
        return self._match("toHaveEdited", _given(path))

    def to_have_changed(self, paths: Pattern | Sequence[Pattern] = _UNSET) -> R:
        return self._match("toHaveChanged", _given(paths))

    def to_stay_within(
        self,
        *,
        tokens: int | None = None,
        tool_calls: int | Mapping[str, int] | None = None,
        duration: int | str | None = None,
    ) -> R:
        """The turn, or every turn of `c`, stayed within each limit given: `tokens` (input and
        output, subagents included), `tool_calls` (a count, or a count per tool) and `duration`
        (`"5m"`, or milliseconds). A turn with no reported usage can't be checked against
        `tokens`, which is an error, not a failure."""
        limits: dict[str, Any] = {}
        if tokens is not None:
            limits["tokens"] = tokens
        if tool_calls is not None:
            limits["toolCalls"] = (
                dict(tool_calls) if isinstance(tool_calls, Mapping) else tool_calls
            )
        if duration is not None:
            limits["duration"] = duration
        return self._match("toStayWithin", [limits])

    def to_pass(self) -> R:
        """The judge's verdict passed."""
        return self._match("toPass", [])


class Expectation(_Matchers[None]):
    """`expect(subject, label)` in a `def` body: each matcher checks at once."""

    def _match(self, matcher: str, args: list[Any]) -> None:
        self._submit(**self._fields(matcher, args))


class AsyncExpectation(_Matchers[Coroutine[Any, Any, None]]):
    """`expect(subject, label)` in an `async def` body: await each matcher."""

    def _match(self, matcher: str, args: list[Any]) -> Coroutine[Any, Any, None]:
        snake = re.sub(r"[A-Z]", lambda m: f"_{m.group().lower()}", matcher)
        return tracked(self._submit(**self._fields(matcher, args)), f"expect(…).{snake}()")


E = TypeVar("E", bound=_Matchers[Any])


class _Checks(Generic[E]):
    def __init__(self, make: type[E], sync: bool, *, soft: bool) -> None:
        self._make = make
        self._sync = sync
        self._soft = soft
        self._name = "expect" if soft else "expect.require"

    def __call__(self, actual: Any, label: str | None = None) -> E:
        submit = _bound(f"{self._name}()", self._sync)
        return self._make(subject_for_matcher(actual), submit, label=label, soft=self._soft)

    def poll(
        self,
        actual: AttemptContext | SyncAttemptContext | Callable[[], object],
        label: str | None = None,
        *,
        interval: timedelta | float | None = None,
        timeout: timedelta | float | None = None,
    ) -> E:
        """Retry the matcher until it passes or `timeout` runs out (default 1 second), trying
        every `interval`; each in seconds or as a timedelta.

        `actual` is `c`, or a function that reads a file or runs a command, which reeval reads
        or runs again on each try: `expect.poll(lambda: c.read_file("ready.txt"))`.
        """
        from reeval_python.context import AttemptContext, SyncAttemptContext, describe

        where = f"{self._name}.poll"
        submit = _bound(f"{where}()", self._sync)
        if isinstance(actual, AttemptContext | SyncAttemptContext):
            subject: MatcherSubject = {"attempt": True}
        elif callable(actual):
            subject = describe(actual)
        else:
            raise TypeError(
                f"{where} takes c, or a function that reads a file or runs a command, e.g. "
                f"{where}(lambda: c.read_file('ready.txt')): a value never changes"
            )
        poll: AttemptCallExpectPoll = {}
        if interval is not None:
            poll["interval"] = _ms(interval, f"{where}(interval=…)")
        if timeout is not None:
            poll["timeout"] = _ms(timeout, f"{where}(timeout=…)")
        return self._make(subject, submit, label=label, soft=self._soft, poll=poll)


class _Expect(_Checks[E]):
    """`expect(actual, label)`: a failed matcher fails the attempt, and the body carries on."""

    def __init__(self, make: type[E], sync: bool) -> None:
        super().__init__(make, sync, soft=True)
        self.require: _Checks[E] = _Checks(make, sync, soft=False)
        """`expect.require(actual, label)`, for a gate: a failed matcher raises
        `ReevalAssertionError`, ending the body there, as `assert` does."""


def _ms(value: timedelta | float, where: str) -> float:
    ms = seconds(value, where) * 1000
    if ms <= 0:
        raise ValueError(f"{where} takes more than zero seconds (got {value!r})")
    return int(ms) if ms == int(ms) else ms


expect: _Expect[Expectation] = _Expect(Expectation, sync=True)
