"""Errors raised by the public Python API."""

from __future__ import annotations


class ReevalAssertionError(AssertionError):
    """An expect matcher failed (mirrors reeval's assertion record message)."""
