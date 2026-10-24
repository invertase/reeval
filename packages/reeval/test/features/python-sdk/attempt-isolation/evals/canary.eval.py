from reeval_python import evaluate, expect


# The mistake: expects the timed-out body's file, which never lands anywhere.
@evaluate("canary")
def canary(c):
    expect(c.exec("test -f zombie.txt")).to_succeed()
