from reeval_python import evaluate


@evaluate("observe")
def observe(c):
    c.observe("orm", "none yet")
    c.send("add a database layer")
    c.observe("orm", "drizzle")
    c.observe("deps", ["drizzle-orm", "pg"])
    c.observe("dep-count", 2)
