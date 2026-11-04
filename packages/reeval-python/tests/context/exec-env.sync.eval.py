from reeval_python import evaluate, expect


@evaluate("exec-env")
def exec_env(c):
    c.exec('printf %s "$GREETING"', env={"GREETING": "hello"})
    c.exec('printf %s "$WHO" > who.txt', background=True, env={"WHO": "background"})
    expect.poll(lambda: c.read_file("who.txt"), interval=0.05, timeout=10).to_be("background")
    expect.poll(
        lambda: c.exec('test "$WHO" = polled', env={"WHO": "polled"}), timeout=10
    ).to_succeed()
