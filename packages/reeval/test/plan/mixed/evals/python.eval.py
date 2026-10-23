from reeval_python.declare import evaluate


@evaluate("from python")
async def hello(_c):
    return None
