"""Loading an eval file: it is a real module, so what looks itself up in sys.modules works."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from stdio_host import Host

from reeval_python.declare import collect_eval_file

DATACLASS = """
from __future__ import annotations

import pickle
import typing
from dataclasses import dataclass

from reeval_python import evaluate, evaluate_each


@dataclass
class Case:
    name: str


assert typing.get_type_hints(Case) == {"name": str}
assert pickle.loads(pickle.dumps(Case("x"))) == Case("x")


@evaluate_each([Case("a"), Case("b")], "case %#")
def each(c, case: Case):
    c.exec(case.name)


@evaluate("sees its own module")
def own(c):
    @dataclass
    class Later:
        n: int

    c.exec(f"true {Later(1).n}")
"""


def _names(tree: object) -> list[str]:
    assert isinstance(tree, dict)
    return [child["name"] for child in tree["children"]]  # pyright: ignore[reportUnknownVariableType]


def test_a_file_with_future_annotations_and_a_dataclass_loads(tmp_path: Path) -> None:
    path = tmp_path / "dataclass.eval.py"
    path.write_text(DATACLASS)
    assert _names(collect_eval_file(path)) == ["case 0", "case 1", "sees its own module"]


def test_two_files_defining_the_same_class_keep_their_own(tmp_path: Path) -> None:
    for name, field in (("one", "a"), ("two", "b")):
        (tmp_path / f"{name}.eval.py").write_text(
            "from __future__ import annotations\n"
            "import typing\n"
            "from dataclasses import dataclass\n"
            "from reeval_python import evaluate\n"
            "@dataclass\n"
            "class Case:\n"
            f"    {field}: int\n"
            f"assert list(typing.get_type_hints(Case)) == [{field!r}]\n"
            f"@evaluate({name!r})\n"
            "def body(c):\n"
            "    pass\n"
        )
    assert _names(collect_eval_file(tmp_path / "one.eval.py")) == ["one"]
    assert _names(collect_eval_file(tmp_path / "two.eval.py")) == ["two"]


def test_a_file_that_fails_to_load_leaves_no_module(tmp_path: Path) -> None:
    path = tmp_path / "broken.eval.py"
    path.write_text("raise RuntimeError('broken')\n")
    before = set(sys.modules)
    with pytest.raises(RuntimeError, match="broken"):
        collect_eval_file(path)
    assert set(sys.modules) == before


def test_the_runner_collects_and_runs_a_dataclass_file(tmp_path: Path) -> None:
    host = Host(tmp_path, DATACLASS)
    try:
        host.start("case 1", key="k1")
        assert host.done("k1") == {"type": "done", "key": "k1"}
        assert [c["command"] for c in host.calls("k1")] == ["b"]
        host.start("sees its own module", key="k2")
        assert host.done("k2") == {"type": "done", "key": "k2"}
        assert [c["command"] for c in host.calls("k2")] == ["true 1"]
    finally:
        host.kill()
