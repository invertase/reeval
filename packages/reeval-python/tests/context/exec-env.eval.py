from reeval_python import evaluate
from reeval_python.aio import expect


@evaluate("exec-env")
async def exec_env(c):
    await c.exec('printf %s "$GREETING"', env={"GREETING": "hello"})
    await c.exec('printf %s "$WHO" > who.txt', background=True, env={"WHO": "background"})
    await expect.poll(lambda: c.read_file("who.txt"), interval=0.05, timeout=10).to_be("background")
    polled = expect.poll(lambda: c.exec('test "$WHO" = polled', env={"WHO": "polled"}), timeout=10)
    await polled.to_succeed()
