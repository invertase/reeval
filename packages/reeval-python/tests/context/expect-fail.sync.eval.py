import contextlib

from reeval_python import ReevalCallError, evaluate, expect


@evaluate("expect-fail")
def expect_fail(c):
    with contextlib.suppress(ReevalCallError):
        expect(1).to_be_shiny()
    expect(1, "one is two").to_be(2)
