"""`expect` for `async def` bodies: each matcher is a coroutine to await.

from reeval_python.aio import expect

await expect(await c.exec("npm test")).to_succeed()
"""

from __future__ import annotations

from typing import Any

from reeval_python.expect import AsyncExpectation, _Expect  # pyright: ignore[reportPrivateUsage]

expect: _Expect[AsyncExpectation] = _Expect(AsyncExpectation, sync=False)


def soft(actual: Any, label: str | None = None) -> AsyncExpectation:
    """`expect.soft(actual, label)`."""
    return expect.soft(actual, label)


__all__ = ["AsyncExpectation", "expect", "soft"]
