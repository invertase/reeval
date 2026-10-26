from reeval_python import evaluate, expect


# A failed expect the body catches still fails the attempt, as expect.soft does when the body ends.
@evaluate("caught expect")
def caught_expect(c):
    try:
        expect(c.exec("test -f missing.txt"), "missing file").to_succeed()
    except AssertionError:
        pass


# A plain assert the body catches records nothing, as in Python: only the try that held counts.
@evaluate("assert retries")
def assert_retries(c):
    for _ in range(2):
        try:
            assert c.exec("test -f ready.txt").ok
            break
        except AssertionError:
            c.exec("touch ready.txt")
