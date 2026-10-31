"""The `source` hashes an eval file declares: its body's source text and each case's data."""

from __future__ import annotations

import textwrap
from pathlib import Path
from typing import Any

import pytest

from reeval_python.declare import collect_eval_file


def _sources(tmp_path: Path, text: str, name: str = "a.eval.py") -> dict[str, Any]:
    path = tmp_path / name
    path.write_text(textwrap.dedent(text), encoding="utf-8")
    tree = collect_eval_file(path)
    found: dict[str, Any] = {}

    def walk(nodes: list[Any]) -> None:
        for node in nodes:
            if node["type"] == "eval":
                found[node["name"]] = node["source"]
            elif node["type"] == "group":
                walk(node["children"])

    walk(tree["children"])
    return found


TWO = """
from reeval_python import evaluate

@evaluate("one", {{"tags": [{tags}]}})
def one(c):
    c.send("{one}")

@evaluate("two")
def two(c):
    c.send("{two}")
"""


def test_a_body_hashes_its_own_source_and_siblings_stay_apart(tmp_path: Path) -> None:
    base = _sources(tmp_path, TWO.format(tags="'a'", one="hi", two="hi"))
    edited = _sources(tmp_path, TWO.format(tags="'a'", one="hi", two="bye"))
    assert edited["one"] == base["one"], "editing a sibling doesn't change this eval"
    assert edited["two"] != base["two"]
    retagged = _sources(tmp_path, TWO.format(tags="'a', 'b'", one="hi", two="hi"))
    assert retagged == base, "the @evaluate decorator, its options included, isn't hashed"


def test_a_bound_method_and_a_wrapped_function_hash_the_function_itself(tmp_path: Path) -> None:
    found = _sources(
        tmp_path,
        """
        import functools
        from reeval_python import evaluate

        def logged(fn):
            @functools.wraps(fn)
            def wrapper(c):
                return fn(c)
            return wrapper

        class Suite:
            def run(self, c):
                c.send("hi")

        @logged
        def inner(c):
            c.send("hi")

        evaluate("bound", Suite().run)
        evaluate("wrapped", inner)
        """,
    )
    assert len(found["bound"]["body"]) == 64
    assert found["wrapped"]["body"] != found["bound"]["body"]
    same = _sources(
        tmp_path,
        """
        from reeval_python import evaluate

        def inner(c):
            c.send("hi")

        evaluate("plain", inner)
        """,
        "b.eval.py",
    )
    assert found["wrapped"] == same["plain"], "the wrapper is looked through, decorators left out"


LAMBDAS = """
from reeval_python import evaluate

evaluate("c", lambda c: c.send("{c}")); evaluate("d", lambda c: c.send("{d}"))
evaluate("n", lambda c: (lambda: c.send("x"))())
"""


def test_a_lambda_hashes_its_own_text_not_its_line(tmp_path: Path) -> None:
    import hashlib

    base = _sources(tmp_path, LAMBDAS.format(c="a", d="a"))
    edited = _sources(tmp_path, LAMBDAS.format(c="a", d="bye"))
    assert edited["c"] == base["c"], "editing the lambda beside it doesn't change this eval"
    assert edited["d"] != base["d"]
    own = 'lambda c: c.send("a")'
    assert base["c"]["body"] == hashlib.sha256(own.encode()).hexdigest()
    nested = 'lambda c: (lambda: c.send("x"))()'
    assert base["n"]["body"] == hashlib.sha256(nested.encode()).hexdigest()


UNWRAPPED = """
from reeval_python import evaluate

def logged(fn):
    def wrapper(c):
        return fn(c)
    return wrapper

@evaluate("e")
@logged
def body(c):
    c.send("{say}")
"""


def test_a_decorator_without_wraps_still_hashes_the_body_it_wrapped(tmp_path: Path) -> None:
    base = _sources(tmp_path, UNWRAPPED.format(say="hi"))
    assert _sources(tmp_path, UNWRAPPED.format(say="hi")) == base, "the same source, the same hash"
    assert _sources(tmp_path, UNWRAPPED.format(say="bye"))["e"] != base["e"]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        (
            'exec("def body(c): pass", globals())\nevaluate("made", body)\n',
            r"evaluate\('made'\): reeval can't read the body's source",
        ),
        (
            'import functools\nevaluate("part", functools.partial(lambda c, n: None, n=1))\n',
            r"evaluate\('part'\): the body is a functools.partial",
        ),
        (
            "class Body:\n    def __call__(self, c): pass\nevaluate('object', Body())\n",
            r"evaluate\('object'\): reeval can't read the body's source",
        ),
    ],
)
def test_a_body_without_source_is_refused(tmp_path: Path, text: str, message: str) -> None:
    path = tmp_path / "a.eval.py"
    path.write_text("from reeval_python import evaluate\n" + text, encoding="utf-8")
    with pytest.raises(TypeError, match=message):
        collect_eval_file(path)


def test_case_data_is_canonical_json_and_non_json_is_refused(tmp_path: Path) -> None:
    found = _sources(
        tmp_path,
        """
        from dataclasses import dataclass
        from reeval_python import evaluate

        @dataclass
        class Case:
            id: str
            n: int

        @evaluate("case", {"cases": [{"id": "0", "b": 1, "a": "é"}, Case("1", 2)]})
        def case(c, item): ...
        """,
    )
    import hashlib

    first = hashlib.sha256('{"a":"é","b":1,"id":"0"}'.encode()).hexdigest()
    assert found["case [0]"]["case"] == first
    assert found["case [1]"]["case"] == hashlib.sha256(b'{"id":"1","n":2}').hexdigest()
    assert found["case [0]"]["body"] == found["case [1]"]["body"]

    path = tmp_path / "c.eval.py"
    path.write_text(
        "from reeval_python import evaluate\n"
        "@evaluate('case', {'cases': [object()], 'case_key': lambda c: '0'})\n"
        "def case(c, item): ...\n",
        encoding="utf-8",
    )
    with pytest.raises(TypeError, match=r"evaluate\('case'\) case '0': reeval fingerprints"):
        collect_eval_file(path)
