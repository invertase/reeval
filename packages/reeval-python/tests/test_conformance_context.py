"""reeval's context/ goldens, replayed through the real runner: the test plays reeval's lines.

Each `tests/context/<case>[.<variant>].eval.py` mirrors one golden. Its body must send exactly
the golden's `runner` lines, given the golden's `reeval` lines as replies.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, cast

import pytest

from tests.runner_process import Runner

HERE = Path(__file__).resolve().parent
GOLDENS = HERE.parents[1] / "reeval" / "test" / "conformance" / "context"
MIRRORS = sorted((HERE / "context").glob("*.eval.py"))


def _golden(case: str) -> list[dict[str, Any]]:
    path = GOLDENS / f"{case}.ndjson"
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _without_stack(msg: dict[str, Any]) -> dict[str, Any]:
    error = msg.get("error")
    if not isinstance(error, dict):
        return msg
    kept = {k: v for k, v in error.items() if k in ("name", "message")}  # pyright: ignore[reportUnknownVariableType]
    return {**msg, "error": kept}


def _check_site(msg: dict[str, Any], mirror: Path) -> None:
    """A check's call names its line in the mirror, which the golden can't hold; drop it."""
    call = msg.get("call")
    if not isinstance(call, dict) or call.get("op") not in ("expect", "record"):  # pyright: ignore[reportUnknownMemberType]
        return
    at = cast(dict[str, Any], call.pop("at"))  # pyright: ignore[reportUnknownMemberType]
    assert Path(at["file"]).resolve() == mirror.resolve(), at
    assert isinstance(at["line"], int) and at["line"] > 0, at


@pytest.mark.parametrize("mirror", MIRRORS, ids=[m.name for m in MIRRORS])
def test_context_golden(mirror: Path, tmp_path: Path) -> None:
    case = mirror.name.split(".")[0]
    lines = _golden(case)
    (tmp_path / "evals").mkdir()
    rel = f"evals/{case}.eval.py"
    shutil.copy(mirror, tmp_path / rel)
    runner = Runner(tmp_path)
    [node] = runner.collect(rel)["children"]
    assert node["options"] == lines[0]["options"], "the mirror declares the golden's options"

    # The transport's `key` isn't in the goldens, which are the attempt protocol's own lines.
    for line in lines[1:]:
        if "reeval" in line:
            msg = dict(line["reeval"])
            if msg.get("type") == "start":
                msg["body"] = node["body"]
            runner.send({**msg, "key": "k1"})
        elif "runner" in line:
            sent = runner.read()
            assert sent.pop("key", None) == "k1"
            _check_site(sent, tmp_path / rel)
            assert _without_stack(sent) == line["runner"]
    assert runner.finish() == [], "the runner sent nothing after the golden's last line"


# JavaScript regular expressions on the wire: Python sends its own patterns ({ matchedBy }).
NOT_PYTHON = {"expect-regexp"}


def test_every_golden_has_a_mirror() -> None:
    goldens = {p.stem for p in GOLDENS.glob("*.ndjson")} - NOT_PYTHON
    mirrored = {m.name.split(".")[0] for m in MIRRORS}
    assert mirrored == goldens, (
        f"unmirrored {sorted(goldens - mirrored)}, extra {sorted(mirrored - goldens)}"
    )
