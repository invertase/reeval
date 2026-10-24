from reeval_python import evaluate


@evaluate("abort", {"timeout": 1})
def abort(c):
    c.exec("sleep 20")
