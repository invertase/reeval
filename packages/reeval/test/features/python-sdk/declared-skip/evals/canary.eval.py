from reeval_python import evaluate, expect


# The mistake: the command prints `ran`, not `skipped`.
@evaluate("canary")
def canary(c):
    expect(c.exec("echo ran").stdout.strip(), "ran").to_be("skipped")
