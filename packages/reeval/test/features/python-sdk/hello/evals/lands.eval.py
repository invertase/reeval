import tomli

from reeval_python.declare import evaluate

assert tomli.__version__


@evaluate("lands")
async def lands(c):
    await c.send(
        'Create a file named greet.py in the workspace root whose entire content is exactly: print("hi")',
    )
    await c.expect({"exec": "test -f greet.py"}, "toSucceed")
    # Cursor's sandbox image has Node, not necessarily python3 on PATH.
    await c.expect(
        {
            "exec": 'node -e "const t=require(\'fs\').readFileSync(\'greet.py\',\'utf8\'); if(!/print\\(.hi.\\)/.test(t)) process.exit(1)"',
        },
        "toSucceed",
    )
    verdict = await c.judge("Does greet.py print hi when run with python3?")
    await c.expect({"value": verdict}, "toPass")
