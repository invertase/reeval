"""reeval's declare/ goldens: each `tests/declare/<case>.eval.py` mirrors one golden's TypeScript
eval file, and loading it must record the golden's tree, with each body's source hash its own."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, cast

import pytest

from reeval_python.declare import collect_eval_file

HERE = Path(__file__).resolve().parent
GOLDENS = HERE.parents[1] / "reeval" / "test" / "conformance" / "declare"
CASES = sorted(p.name for p in GOLDENS.iterdir() if (p / "expected.json").is_file())


def _bodies(node: Any, found: list[str]) -> Any:
    """The tree with each body id as `<body>`, collecting the ids: they are opaque."""
    if isinstance(node, list):
        return [_bodies(n, found) for n in node]  # pyright: ignore[reportUnknownVariableType]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():  # pyright: ignore[reportUnknownVariableType]
        if key == "body":
            found.append(str(value))  # pyright: ignore[reportUnknownArgumentType]
            out[key] = "<body>"
        elif key == "source":
            # The body's source text is each language's own; case data is canonical JSON.
            source = cast(dict[str, Any], value)
            assert re.fullmatch(r"[0-9a-f]{64}", source["body"])
            out[key] = {**source, "body": "<sha256>"}
        elif key == "children":
            out[key] = _bodies(value, found)
        else:
            out[str(key)] = value  # pyright: ignore[reportUnknownArgumentType]
    return out


@pytest.mark.parametrize("case", CASES)
def test_declare_golden(case: str) -> None:
    mirror = HERE / "declare" / f"{case}.eval.py"
    assert mirror.is_file(), f"no Python mirror for declare/{case}: write {mirror.name}"
    expected = json.loads((GOLDENS / case / "expected.json").read_text())
    ours: list[str] = []
    theirs: list[str] = []
    actual = _bodies(collect_eval_file(mirror), ours)
    assert actual == _bodies(expected, theirs)
    assert len(set(ours)) == len(ours) == len(theirs)
