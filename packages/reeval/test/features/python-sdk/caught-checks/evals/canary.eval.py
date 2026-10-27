from reeval_python import evaluate, expect


# The mistake: the same expect, not caught, fails the attempt.
@evaluate("canary")
def canary(c):
    expect(c.exec("test -f missing.txt"), "missing file").to_succeed()
