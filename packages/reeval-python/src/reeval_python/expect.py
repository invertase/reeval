"""Fluent expect() API; maps to wire matchers internally."""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from reeval_python.wire import MATCHER_TO_WIRE, subject_for_matcher, wire_args

SubmitFn = Any

_submit: ContextVar[SubmitFn | None] = ContextVar("_submit", default=None)


def bind_expect(submit: SubmitFn) -> None:
    _submit.set(submit)


def expect(actual: Any, label: str | None = None) -> _Expectation:
    submit = _submit.get()
    if submit is None:
        raise RuntimeError("expect() must run inside an eval body")
    return _Expectation(actual, submit, label=label)


class _Expectation:
    def __init__(
        self,
        actual: Any,
        submit: SubmitFn,
        *,
        label: str | None = None,
        not_: bool = False,
        soft: bool = False,
    ) -> None:
        self._actual = actual
        self._submit = submit
        self._label = label
        self._not = not_
        self._soft = soft
        self._sync = bool(getattr(submit, "_sync_mode", False))

    @property
    def not_(self) -> _Expectation:
        return _Expectation(
            self._actual,
            self._submit,
            label=self._label,
            not_=not self._not,
            soft=self._soft,
        )

    def __getattr__(self, name: str) -> Any:
        if not name.startswith("to_"):
            raise AttributeError(name)
        wire = MATCHER_TO_WIRE.get(name)
        if wire is None:
            raise AttributeError(f"unknown matcher {name}")

        async def _async_matcher(*args: Any) -> None:
            subject = subject_for_matcher(self._actual, wire)
            await self._submit(
                subject=subject,
                matcher=wire,
                args=wire_args(args),
                label=self._label,
                not_=self._not,
                soft=self._soft,
            )

        def _sync_matcher(*args: Any) -> None:
            subject = subject_for_matcher(self._actual, wire)
            self._submit(
                subject=subject,
                matcher=wire,
                args=wire_args(args),
                label=self._label,
                not_=self._not,
                soft=self._soft,
            )

        return _sync_matcher if self._sync else _async_matcher


class soft:  # noqa: N801
    """expect.soft(subject, label?) — soft assertion."""

    def __init__(self, actual: Any, label: str | None = None) -> None:
        submit = _submit.get()
        if submit is None:
            raise RuntimeError("expect.soft() must run inside an eval body")
        self._inner = _Expectation(actual, submit, label=label, soft=True)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)
