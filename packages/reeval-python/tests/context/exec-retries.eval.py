from reeval_python import evaluate


@evaluate("exec-retries")
async def exec_retries(c):
    await c.exec("test -f .tried || { touch .tried; exit 1; }", retries=2, interval=0)
    await c.exec("exit 4", retries=1, interval=0)
