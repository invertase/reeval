import contextlib

from reeval_python import ReevalCallError, evaluate, expect


@evaluate("expect-fail")
async def expect_fail(c):
    with contextlib.suppress(ReevalCallError):
        await expect(1).to_be_shiny()
    await expect(1, "one is two").to_be(2)
