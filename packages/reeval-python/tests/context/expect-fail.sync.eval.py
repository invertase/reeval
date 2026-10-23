import contextlib

from reeval_python import ReevalCallError, evaluate, expect


@evaluate("expect-fail")
def expect_fail(c):
    with contextlib.suppress(ReevalCallError):
        # Typed matchers can't name one reeval doesn't have; the private call can.
        expect(1)._match("toBeShiny", [])
    expect(1, "one is two").to_be(2)
