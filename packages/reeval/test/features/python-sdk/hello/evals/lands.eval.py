import tomli

from reeval_python import evaluate, expect

assert tomli.__version__


@evaluate("lands")
def lands(c):
    c.send(
        'Create a file named greet.py in the workspace root whose entire content is exactly: print("hi")',
    )
    expect(c.exec("test -f greet.py")).to_succeed()
    # Cursor's sandbox image has Node, not necessarily python3 on PATH.
    expect(
        c.exec(
            'node -e "const t=require(\'fs\').readFileSync(\'greet.py\',\'utf8\'); if(!/print\\(.hi.\\)/.test(t)) process.exit(1)"',
        ),
    ).to_succeed()
    verdict = c.judge("Does greet.py print hi when run with python3?")
    expect(verdict).to_pass()
