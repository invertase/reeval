"""`expect` for `async def` bodies: each matcher is a coroutine to await.

from reeval_python.aio import expect

await expect(await c.exec("npm test")).to_succeed()
"""

from __future__ import annotations

from reeval_python.expect import AsyncExpectation, _Expect  # pyright: ignore[reportPrivateUsage]

expect: _Expect[AsyncExpectation] = _Expect(AsyncExpectation, sync=False)

__all__ = ["AsyncExpectation", "expect"]
