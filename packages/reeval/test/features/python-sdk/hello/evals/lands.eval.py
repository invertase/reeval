import tomli

from reeval_python import evaluate, expect

assert tomli.__version__


@evaluate("lands")
def lands(c):
    c.send(
        'Create a file named greet.py in the workspace root whose entire content is exactly: print("hi")',
    )
    assert c.exec("test -f greet.py").ok
    # Cursor's sandbox image has Node, not necessarily python3 on PATH.
    node_check = c.exec(
        'node -e "const t=require(\'fs\').readFileSync(\'greet.py\',\'utf8\'); if(!/print\\(.hi.\\)/.test(t)) process.exit(1)"',
    )
    assert node_check.ok, "greet.py content matches print(hi)"
    verdict = c.judge("Does greet.py print hi when run with python3?", task=True, diff=True)
    assert verdict.passed, f"judge score {verdict.score} below {verdict.threshold}"
