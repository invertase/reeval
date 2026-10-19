from reeval_py.declare import evaluate


@evaluate("hello")
async def hello(_c):
    return None
