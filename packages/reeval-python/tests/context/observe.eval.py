from reeval_python import evaluate


@evaluate("observe")
async def observe(c):
    await c.observe("orm", "none yet")
    await c.send("add a database layer")
    await c.observe("orm", "drizzle")
    await c.observe("deps", ["drizzle-orm", "pg"])
    await c.observe("dep-count", 2)
