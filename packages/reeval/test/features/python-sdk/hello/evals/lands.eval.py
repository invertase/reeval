from reeval_py.declare import evaluate


@evaluate("lands")
async def lands(c):
    await c.send("Run once.")
    await c.expect({"exec": "cat marker.txt"}, "toSucceed")
