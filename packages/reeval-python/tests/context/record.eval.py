from types import SimpleNamespace

from reeval_python import evaluate


@evaluate("record")
def record(c):
    exists = True
    assert exists, "greet.py exists"
    result = SimpleNamespace(ok=True)
    assert result.ok
    assert result.ok
    one = 1
    assert one == 2, "one is two"
