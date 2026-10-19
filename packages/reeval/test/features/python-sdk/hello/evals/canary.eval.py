from reeval_py.declare import evaluate


@evaluate("canary")
async def canary(c):
    await c.send("Run once.")
    await c.expect({"exec": "cat missing.txt"}, "toSucceed")
