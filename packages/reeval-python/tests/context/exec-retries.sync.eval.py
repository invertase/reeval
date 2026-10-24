from reeval_python import evaluate


@evaluate("exec-retries")
def exec_retries(c):
    c.exec("test -f .tried || { touch .tried; exit 1; }", retries=2, interval=0)
    c.exec("exit 4", retries=1, interval=0)
