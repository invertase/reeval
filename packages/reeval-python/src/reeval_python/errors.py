"""Errors raised by the public Python API."""

from __future__ import annotations


class ReevalAssertionError(AssertionError):
    """An expect matcher failed (mirrors reeval's assertion record message)."""


class AttemptAborted(BaseException):  # noqa: N818
    """reeval aborted the attempt (its timeout ran out, or the run was cancelled): every call the
    body makes from then on raises this. A `BaseException`, so `except Exception` can't keep a
    body running that reeval has already given up on."""

    def __init__(self, name: str, message: str) -> None:
        super().__init__(message)
        self.name = name
