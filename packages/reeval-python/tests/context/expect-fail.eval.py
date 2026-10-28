import contextlib

from reeval_python import ReevalCallError, evaluate
from reeval_python.aio import expect


@evaluate("expect-fail")
async def expect_fail(c):
    with contextlib.suppress(ReevalCallError):
        # Typed matchers can't name one reeval doesn't have; the private call can.
        await expect(1)._match("toBeShiny", [])
    await expect.require(1, "one is two").to_be(2)
