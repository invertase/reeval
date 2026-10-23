"""`expect`: reeval's matchers, with snake_case names, run by reeval on what the eval hands it."""

from __future__ import annotations

import itertools
from collections.abc import Coroutine
from contextvars import ContextVar
from typing import Any

from reeval_python._wire import AttemptCallExpectPoll
from reeval_python.wire import matcher_to_wire, subject_for_matcher

SubmitFn = Any

_submit: ContextVar[SubmitFn | None] = ContextVar("_submit", default=None)

# An async body's matchers not awaited yet, by name; the runner fails a body that leaves any.
_unawaited: ContextVar[dict[int, str] | None] = ContextVar("_unawaited", default=None)


_tokens = itertools.count()


def bind_expect(submit: SubmitFn) -> None:
    _submit.set(submit)
    _unawaited.set({})


def unawaited_matchers() -> list[str]:
    return list((_unawaited.get() or {}).values())


def _bound(what: str) -> SubmitFn:
    submit = _submit.get()
    if submit is None:
        raise RuntimeError(f"{what} must run inside an eval body")
    return submit


class Expectation:
    """`expect(subject, label)`: call a matcher on it, e.g. `.to_have_edited("greet.py")`, or
    `.not_` first. In an async body, await the matcher."""

    def __init__(
        self,
        actual: Any,
        submit: SubmitFn,
        *,
        label: str | None = None,
        not_: bool = False,
        soft: bool = False,
        poll: AttemptCallExpectPoll | None = None,
    ) -> None:
        self._actual = actual
        self._submit = submit
        self._label = label
        self._not = not_
        self._soft = soft
        self._poll = poll
        self._sync = bool(getattr(submit, "_sync_mode", False))

    @property
    def not_(self) -> Expectation:
        return Expectation(
            self._actual,
            self._submit,
            label=self._label,
            not_=not self._not,
            soft=self._soft,
            poll=self._poll,
        )

    def __getattr__(self, name: str) -> Any:
        if not name.startswith("to_"):
            raise AttributeError(name)
        fields: dict[str, Any] = {
            "subject": subject_for_matcher(self._actual),
            "matcher": matcher_to_wire(name),
            "label": self._label,
            "not_": self._not,
            "soft": self._soft,
        }
        if self._poll is not None:
            fields["poll"] = self._poll

        def _sync_matcher(*args: Any) -> None:
            self._submit(args=list(args), **fields)

        if self._sync:
            return _sync_matcher

        def _async_matcher(*args: Any) -> Coroutine[Any, Any, None]:
            pending = _unawaited.get()
            token = next(_tokens)
            if pending is not None:
                pending[token] = name

            async def run() -> None:
                if pending is not None:
                    pending.pop(token, None)
                await self._submit(args=list(args), **fields)

            return run()

        return _async_matcher


class _Expect:
    def __call__(self, actual: Any, label: str | None = None) -> Expectation:
        return Expectation(actual, _bound("expect()"), label=label)

    def soft(self, actual: Any, label: str | None = None) -> Expectation:
        """A check whose failure fails the attempt once the body is done, not here."""
        return Expectation(actual, _bound("expect.soft()"), label=label, soft=True)

    def poll(
        self,
        actual: Any,
        label: str | None = None,
        *,
        interval: int | None = None,
        timeout: int | None = None,
    ) -> Expectation:
        """Retry the matcher until it passes or `timeout` (ms) runs out, re-reading the subject
        (`c.read_file(path)` or `c.exec(command)` unawaited, or `c`) every `interval` ms."""
        poll: AttemptCallExpectPoll = {}
        if interval is not None:
            poll["interval"] = interval
        if timeout is not None:
            poll["timeout"] = timeout
        return Expectation(actual, _bound("expect.poll()"), label=label, poll=poll)


expect = _Expect()


def soft(actual: Any, label: str | None = None) -> Expectation:
    """`expect.soft(actual, label)`."""
    return expect.soft(actual, label)
