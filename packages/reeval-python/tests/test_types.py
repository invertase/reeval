"""What pyright tells an eval's author: a matcher or a command an async body forgot to await, and
a matcher reeval doesn't have."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SAMPLE = """
from reeval_python import AttemptContext, SyncAttemptContext, evaluate, expect
from reeval_python import aio


@evaluate("sync")
def sync_body(c: SyncAttemptContext) -> None:
    result = c.exec("npm test")
    assert result.exit_code == 0
    expect(result).to_succeed()
    expect.poll(lambda: c.read_file("ready.txt")).to_be("ready")


@evaluate("async")
async def async_body(c: AttemptContext) -> None:
    result = await c.exec("npm test")
    await aio.expect(result).to_succeed()
    aio.expect(result).to_succeed()  # never awaited
    print(c.exec("npm test").exit_code)  # no exit_code
    expect(result).to_succeeed()  # no such matcher
"""


def test_pyright_finds_a_missing_await_and_an_unknown_matcher(tmp_path: Path) -> None:
    sample = tmp_path / "sample.eval.py"
    sample.write_text(SAMPLE)
    out = subprocess.run(
        [sys.executable, "-m", "pyright", "--outputjson", "--pythonpath", sys.executable, sample],
        capture_output=True,
        text=True,
        check=False,
    )
    report = json.loads(out.stdout)
    line = {n: i for i, text in enumerate(SAMPLE.splitlines()) for n in [text.split("# ")[-1]]}
    errors = sorted(
        (d["range"]["start"]["line"], d.get("rule", ""))
        for d in report["generalDiagnostics"]
        if d["severity"] == "error"
        and d.get("rule") in ("reportUnusedCoroutine", "reportAttributeAccessIssue")
    )
    assert errors == [
        (line["never awaited"], "reportUnusedCoroutine"),
        (line["no exit_code"], "reportAttributeAccessIssue"),
        (line["no such matcher"], "reportAttributeAccessIssue"),
    ], report["generalDiagnostics"]
    clean = [d for d in report["generalDiagnostics"] if d["range"]["start"]["line"] < errors[0][0]]
    assert clean == [], "the sync body and the awaited calls type-check"


MISUSE = """
from datetime import timedelta

from reeval_python import AttemptContext, SyncAttemptContext, evaluate, expect
from reeval_python import aio


@evaluate("ok", {"runs": 2, "timeout": timedelta(minutes=5)})
async def ok(c: AttemptContext) -> None:
    await c.judge("did it work?", threshold=0.5, diff=True)
    await aio.expect.poll(lambda: c.read_file("x"), timeout=1.5).to_be("y")


@evaluate("cases", {"cases": [{"n": 1}], "case_key": lambda c: str(c["n"])})
def ok_each(c: SyncAttemptContext, case: dict[str, int]) -> None: ...


@evaluate("wrong context")  # flagged
async def wrong_context(c: SyncAttemptContext) -> None: ...


@evaluate("sync generator")  # flagged
def sync_generator(c: SyncAttemptContext):
    yield


@evaluate("async generator")  # flagged
async def async_generator(c: AttemptContext):
    yield


@evaluate("returns a value")  # flagged
def returns_value(c: SyncAttemptContext) -> bool:
    return True


@evaluate("wrong cases", {"cases": [1]})  # flagged
async def wrong_each(c: SyncAttemptContext, case: int) -> None: ...


@evaluate("misspelled option", {"runz": 3})  # flagged
def misspelled(c: SyncAttemptContext) -> None:
    c.judge("q", treshold=1)  # flagged
    expect.poll(c.read_file("x")).to_be("y")  # flagged
    expect.poll(c.read_file).to_be("y")  # flagged
    expect.poll(c, timeout="1s").to_have_file("x")  # flagged
"""


def test_pyright_refuses_a_misdeclared_body_and_misspelled_options(tmp_path: Path) -> None:
    sample = tmp_path / "misuse.eval.py"
    sample.write_text(MISUSE)
    out = subprocess.run(
        [sys.executable, "-m", "pyright", "--outputjson", "--pythonpath", sys.executable, sample],
        capture_output=True,
        text=True,
        check=False,
    )
    report = json.loads(out.stdout)
    lines = MISUSE.splitlines()
    errors = {
        d["range"]["start"]["line"]
        for d in report["generalDiagnostics"]
        if d["severity"] == "error"
    }
    flagged = {i for i, text in enumerate(lines) if text.endswith("# flagged")}
    # pyright reports a refused decorator on the decorator's line or on the def below it.
    found = {i if i in flagged else i - 1 for i in errors}
    assert found == flagged, [
        (lines[d["range"]["start"]["line"]], d["message"]) for d in report["generalDiagnostics"]
    ]
