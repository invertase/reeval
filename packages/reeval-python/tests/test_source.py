"""The `source` hashes an eval file declares: its body's source text and each case's data."""

from __future__ import annotations

import textwrap
from pathlib import Path
from typing import Any

import pytest

from reeval_python.declare import collect_eval_file


def _sources(tmp_path: Path, text: str, name: str = "a.eval.py") -> dict[str, Any]:
    path = tmp_path / name
    path.write_text(textwrap.dedent(text))
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
    path.write_text("from reeval_python import evaluate\n" + text)
    with pytest.raises(TypeError, match=message):
        collect_eval_file(path)


def test_case_data_is_canonical_json_and_non_json_is_refused(tmp_path: Path) -> None:
    found = _sources(
        tmp_path,
        """
        from dataclasses import dataclass
        from reeval_python import evaluate_each

        @dataclass
        class Case:
            n: int

        @evaluate_each([{"b": 1, "a": "é"}, Case(2)], "case %#")
        def case(c, item): ...
        """,
    )
    import hashlib

    first = hashlib.sha256('{"a":"é","b":1}'.encode()).hexdigest()
    assert found["case 0"]["case"] == first
    assert found["case 1"]["case"] == hashlib.sha256(b'{"n":2}').hexdigest()
    assert found["case 0"]["body"] == found["case 1"]["body"]

    path = tmp_path / "c.eval.py"
    path.write_text(
        "from reeval_python import evaluate_each\n"
        "@evaluate_each([object()], 'case %#')\n"
        "def case(c, item): ...\n"
    )
    with pytest.raises(TypeError, match=r"evaluate_each\('case %#'\) case 0: reeval fingerprints"):
        collect_eval_file(path)
