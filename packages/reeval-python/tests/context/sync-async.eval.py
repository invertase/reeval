from reeval_python import evaluate, expect


@evaluate("sync-async")
def sync_async(c):
    expect(c.exec("echo sync-async-ok")).to_succeed()
