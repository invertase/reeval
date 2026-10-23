from reeval_python import evaluate


@evaluate("abort", {"timeout": 1})
async def abort(c):
    await c.exec("sleep 20")
