"""The runner's attempts, with the test as reeval: keys, aborts and the calls bodies make."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest
from stdio_host import Host

EVALS = """
import time
from reeval_python import evaluate, expect, soft


@evaluate("sleeps then calls")
def sleeps_then_calls(c):
    time.sleep(0.3)
    c.exec("echo after-abort")


@evaluate("calls")
def calls(c):
    time.sleep(0.5)
    c.exec("echo calls")


@evaluate("soft then more")
def soft_then_more(c):
    soft(c.exec("false")).to_succeed()
    c.exec("echo still-running")


@evaluate("writes and judges")
async def writes_and_judges(c):
    await c.write_file("data.bin", bytes([0, 1]))
    await c.judge("q")
"""


@pytest.fixture
def host(tmp_path: Path):
    h = Host(tmp_path, EVALS)
    yield h
    h.kill()


def test_two_bodies_on_one_attempt_id_keep_their_own_calls(host: Host) -> None:
    host.start("sleeps then calls", "k1")
    host.start("calls", "k2")
    host.done("k1")
    host.done("k2")
    assert host.calls("k1") == [{"op": "exec", "command": "echo after-abort"}]
    assert host.calls("k2") == [{"op": "exec", "command": "echo calls"}]


def test_an_abort_stops_only_the_body_it_names(host: Host) -> None:
    host.start("sleeps then calls", "k1")
    host.start("calls", "k2")
    host.abort("k1", "cancelled", "x")
    assert "error" not in host.done("k2")
    assert host.done("k1")["error"] == {"name": "AbortError", "message": "x"}


def test_an_aborted_sync_body_makes_no_more_calls(host: Host) -> None:
    host.start("sleeps then calls", "k1")
    time.sleep(0.05)
    host.abort("k1")
    assert host.done("k1")["error"] == {"name": "TimeoutError", "message": "late"}
    time.sleep(0.6)
    assert host.calls("k1") == [], "the body's thread called reeval after the abort"


def test_a_soft_failure_lets_the_body_go_on(host: Host) -> None:
    host.start("soft then more")
    assert "error" not in host.done()
    commands = [c.get("command") for c in host.calls() if c["op"] == "exec"]
    assert commands == ["false", "echo still-running"]


def test_bytes_go_as_base64_and_a_judge_without_options_sends_none(host: Host) -> None:
    host.start("writes and judges")
    assert "error" not in host.done()
    assert host.calls() == [
        {"op": "writeFile", "path": "data.bin", "contents": "AAE=", "encoding": "base64"},
        {"op": "judge", "question": "q"},
    ]


def test_a_body_the_runner_cancels_without_an_abort_ends_with_an_error() -> None:
    from reeval_python.runner import (
        _cancelled_done,  # pyright: ignore[reportPrivateUsage]
        _Connection,  # pyright: ignore[reportPrivateUsage]
    )

    written: list[dict[str, Any]] = []

    class Frames:
        def write(self, msg: dict[str, Any]) -> None:
            written.append(msg)

    conn = _Connection(Frames())  # type: ignore[arg-type]
    _cancelled_done(conn, "k1")
    conn.abort("k2", "TimeoutError", "Eval timed out after 1s")
    _cancelled_done(conn, "k2")
    assert written == [
        {
            "type": "done",
            "key": "k1",
            "error": {
                "name": "RunnerError",
                "message": "the runner stopped this body without reeval aborting it",
            },
        },
        {
            "type": "done",
            "key": "k2",
            "error": {"name": "TimeoutError", "message": "Eval timed out after 1s"},
        },
    ]
