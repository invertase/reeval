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
