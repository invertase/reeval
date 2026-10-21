from reeval_python import evaluate, expect


@evaluate("canary")
def canary(c):
    expect(c.exec("test -f missing-greet.py")).to_succeed()
