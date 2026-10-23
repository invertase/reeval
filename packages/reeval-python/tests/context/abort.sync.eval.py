from reeval_python import evaluate


@evaluate("abort", {"timeout": "1s"})
def abort(c):
    c.exec("sleep 20")
