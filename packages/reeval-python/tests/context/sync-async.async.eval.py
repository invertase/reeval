from reeval_python import evaluate, expect


@evaluate("sync-async")
async def sync_async(c):
    await expect(await c.exec("echo sync-async-ok")).to_succeed()
