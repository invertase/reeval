"""`expect` for `def` bodies: reeval's matchers, with snake_case names, each a blocking call.

`reeval_python.aio.expect` is the same for `async def` bodies, where each matcher is awaited.
reeval runs the matcher on what the eval hands it and records the check.
"""

from __future__ import annotations

import itertools
import re
from collections.abc import Callable, Coroutine, Sequence
from contextvars import ContextVar
from typing import Any, Generic, Self, TypeVar

from reeval_python._wire import AttemptCallExpectPoll, MatcherSubject
from reeval_python.wire import subject_for_matcher

SubmitFn = Any

_submit: ContextVar[SubmitFn | None] = ContextVar("_submit", default=None)

# An async body's matchers not awaited yet, by name; the runner fails a body that leaves any.
_unawaited: ContextVar[dict[int, str] | None] = ContextVar("_unawaited", default=None)

_tokens = itertools.count()

R = TypeVar("R")

Pattern = str | re.Pattern[str] | re.Pattern[bytes]
ToolInput = str | re.Pattern[str] | re.Pattern[bytes] | dict[str, Any]

_UNSET: Any = object()


def bind_expect(submit: SubmitFn) -> None:
    _submit.set(submit)
    _unawaited.set({})


def unawaited_matchers() -> list[str]:
    return list((_unawaited.get() or {}).values())


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
        soft: bool = False,
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
        pending = _unawaited.get()
        token = next(_tokens)
        if pending is not None:
            pending[token] = re.sub(r"[A-Z]", lambda m: f"_{m.group().lower()}", matcher)
        fields = self._fields(matcher, args)

        async def run() -> None:
            if pending is not None:
                pending.pop(token, None)
            await self._submit(**fields)

        return run()


E = TypeVar("E", bound=_Matchers[Any])


class _Expect(Generic[E]):
    def __init__(self, make: type[E], sync: bool) -> None:
        self._make = make
        self._sync = sync

    def __call__(self, actual: Any, label: str | None = None) -> E:
        submit = _bound("expect()", self._sync)
        return self._make(subject_for_matcher(actual), submit, label=label)

    def soft(self, actual: Any, label: str | None = None) -> E:
        """A check whose failure fails the attempt once the body is done, not here."""
        submit = _bound("expect.soft()", self._sync)
        return self._make(subject_for_matcher(actual), submit, label=label, soft=True)

    def poll(
        self,
        actual: Callable[[], object] | Any,
        label: str | None = None,
        *,
        interval: int | None = None,
        timeout: int | None = None,
    ) -> E:
        """Retry the matcher until it passes or `timeout` (ms) runs out, every `interval` ms.

        `actual` is `c`, or a function that reads a file or runs a command, which reeval reads
        or runs again on each try: `expect.poll(lambda: c.read_file("ready.txt"))`.
        """
        from reeval_python.context import AttemptContext, SyncAttemptContext, describe

        submit = _bound("expect.poll()", self._sync)
        if isinstance(actual, AttemptContext | SyncAttemptContext):
            subject: MatcherSubject = {"attempt": True}
        elif callable(actual):
            subject = describe(actual)
        else:
            raise TypeError(
                "expect.poll takes c, or a function that reads a file or runs a command, e.g. "
                "expect.poll(lambda: c.read_file('ready.txt')): a value never changes"
            )
        poll: AttemptCallExpectPoll = {}
        if interval is not None:
            poll["interval"] = interval
        if timeout is not None:
            poll["timeout"] = timeout
        return self._make(subject, submit, label=label, poll=poll)


expect: _Expect[Expectation] = _Expect(Expectation, sync=True)


def soft(actual: Any, label: str | None = None) -> Expectation:
    """`expect.soft(actual, label)`."""
    return expect.soft(actual, label)
