from reeval_python import evaluate


@evaluate("abort", {"timeout": "1s"})
async def abort(c):
    await c.exec("sleep 20")
