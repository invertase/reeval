"""Asserts through the runner: what reaches reeval as `record` calls, and what a failure says."""

from __future__ import annotations

import time
from pathlib import Path

from stdio_host import Host

EVALS = """
import asyncio
import time
from reeval_python import evaluate
from helper import must_be_even


@evaluate("awaits")
async def awaits(c):
    async def two():
        await asyncio.sleep(0)
        return 2
    assert await two() == 2
    assert await two() == 3, "two is three"


@evaluate("helper")
def helper(c):
    must_be_even(3)


@evaluate("retries")
def retries(c):
    for n in (1, 2):
        try:
            assert n == 2
            break
        except AssertionError:
            pass


@evaluate("message raises")
def message_raises(c):
    assert False, 1 / 0


@evaluate("after abort")
def after_abort(c):
    time.sleep(0.3)
    assert True
"""

HELPER = """
def must_be_even(n):
    assert n % 2 == 0
"""


def _host(tmp_path: Path, **kwargs: bool) -> Host:
    (tmp_path / "helper.py").write_text(HELPER)
    return Host(tmp_path, EVALS, **kwargs)


def _records(host: Host) -> list[dict[str, object]]:
    return [c for c in host.calls() if c["op"] == "record"]


def test_an_async_body_records_awaited_compares_and_its_traceback_ends_in_the_eval(
    tmp_path: Path,
) -> None:
    host = _host(tmp_path)
    try:
        host.start("awaits")
        error = host.done()["error"]
        assert _records(host) == [
            {"op": "record", "matcher": "assert", "subject": "await two() == 2", "status": "pass"},
            {
                "op": "record",
                "matcher": "assert",
                "subject": "await two() == 3",
                "message": "two is three: assert 2 == 3",
                "status": "fail",
            },
        ]
        assert error["name"] == "AssertionError"
        assert error["message"] == "two is three: assert 2 == 3"
        stack = error["stack"].strip().splitlines()
        assert "x.eval.py" in stack[-3], stack
        assert stack[-1] == "AssertionError: two is three: assert 2 == 3"
        assert "checks.py" not in error["stack"]
    finally:
        host.kill()


def test_a_helper_modules_assert_is_recorded_by_its_test(tmp_path: Path) -> None:
    host = _host(tmp_path)
    try:
        host.start("helper")
        assert host.done()["error"]["message"] == "assert n % 2 == 0"
        assert _records(host) == [
            {
                "op": "record",
                "matcher": "assert",
                "subject": "n % 2 == 0",
                "status": "fail",
                "message": "assert n % 2 == 0",
            }
        ]
    finally:
        host.kill()


def test_a_failure_the_body_catches_is_not_recorded(tmp_path: Path) -> None:
    host = _host(tmp_path)
    try:
        host.start("retries")
        assert "error" not in host.done()
        assert _records(host) == [
            {"op": "record", "matcher": "assert", "subject": "n == 2", "status": "pass"},
        ]
    finally:
        host.kill()


def test_an_assert_whose_message_raised_is_recorded_when_its_error_escapes(
    tmp_path: Path,
) -> None:
    host = _host(tmp_path)
    try:
        host.start("message raises")
        assert host.done()["error"]["name"] == "ZeroDivisionError"
        assert [(c["subject"], c["status"]) for c in _records(host)] == [("False", "fail")]
    finally:
        host.kill()


def test_a_refused_record_is_shown_in_the_attempts_log(tmp_path: Path) -> None:
    host = _host(tmp_path, answer=False)
    try:
        host.start("awaits")
        record = host.wait(lambda m: m.get("call", {}).get("op") == "record")
        refusal = {"name": "UsageError", "message": "no such matcher"}
        host.send({"id": record["id"], "key": "k1", "ok": False, "op": "record", "error": refusal})
        host.wait(lambda m: m.get("t") == "log")
        assert host.logs() == ["reeval refused a check: UsageError: no such matcher"]
    finally:
        host.kill()


def test_an_aborted_body_records_nothing_more(tmp_path: Path) -> None:
    host = _host(tmp_path)
    try:
        host.start("after abort")
        host.abort("k1")
        host.done()
        time.sleep(0.6)
        assert host.calls() == []
    finally:
        host.kill()


def test_an_eval_file_in_another_encoding_loads(tmp_path: Path) -> None:
    (tmp_path / "evals").mkdir()
    source = (
        "# -*- coding: latin-1 -*-\n"
        "from reeval_python import evaluate\n\n\n"
        '@evaluate("café")\n'
        "def cafe(c):\n"
        "    pass\n"
    )
    (tmp_path / "evals" / "latin.eval.py").write_bytes(source.encode("latin-1"))
    host = Host(tmp_path, "")
    try:
        host.send({"t": "collect", "file": "evals/latin.eval.py"})
        declared = host.wait(lambda m: m.get("file") == "evals/latin.eval.py")
        assert [n["name"] for n in declared["tree"]["children"]] == ["café"]
    finally:
        host.kill()
