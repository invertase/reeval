from reeval_python.declare import evaluate


@evaluate("hello")
async def hello(_c):
    return None
