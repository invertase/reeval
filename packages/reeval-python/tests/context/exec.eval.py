from reeval_python import evaluate


@evaluate("exec")
async def exec_(c):
    await c.exec("echo hello")
    await c.exec("echo oops >&2; exit 3")
    server = await c.exec("sleep 30", background=True)
    await c.kill(server)
    await c.kill(server)
