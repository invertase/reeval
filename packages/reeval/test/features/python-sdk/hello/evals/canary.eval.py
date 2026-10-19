from reeval_py.declare import evaluate


@evaluate("canary")
async def canary(c):
    await c.send(
        'Create a file named greet.py in the workspace root whose entire content is exactly: print("hi")',
    )
    await c.expect({"exec": "test -f greet.py"}, "toSucceed")
    # Must fail: greet.py should exist, this path does not.
    await c.expect({"exec": "test -f missing-greet.py"}, "toSucceed")
