from reeval_python import evaluate


@evaluate("exec")
def exec_(c):
    c.exec("echo hello")
    c.exec("echo oops >&2; exit 3")
    server = c.exec("sleep 30", background=True)
    c.kill(server)
    c.kill(server)
