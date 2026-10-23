import time

from reeval_python import evaluate, expect


# Runs first and times out. Its body wakes while "lands" (same file, same cell, so the same
# attempt id) is running, and tries to run a command there.
@evaluate("times out", {"timeout": "1s"})
def times_out(c):
    time.sleep(2)
    expect(c.exec("touch zombie.txt")).to_succeed()


@evaluate("lands")
def lands(c):
    time.sleep(3)
    expect(c.exec("test ! -f zombie.txt")).to_succeed()
