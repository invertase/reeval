import json
from pathlib import Path

import pytest

from reeval_py.declare import collect_module_tree_sync
from tests.evals.tags_mirror import declare_tags

PKG_ROOT = Path(__file__).resolve().parents[1]
CONFORMANCE = PKG_ROOT.parent / "reeval" / "test" / "conformance" / "declare"


def _load_expected(case: str) -> dict:
    path = CONFORMANCE / case / "expected.json"
    return json.loads(path.read_text())


@pytest.mark.parametrize("case", ["tags"])
def test_declare_matches_golden(case: str) -> None:
    expected = _load_expected(case)
    if case == "tags":
        actual = collect_module_tree_sync(declare_tags)
    else:
        raise AssertionError(f"no Python mirror for {case}")
    assert actual == expected
