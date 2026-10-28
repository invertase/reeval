"""The runner's attempts, with the test as reeval: keys, aborts and the calls bodies make."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest
from stdio_host import Host

EVALS = """
import time
from reeval_python import aio, evaluate, expect


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
    expect(c.exec("false")).to_succeed()
    c.exec("echo still-running")


@evaluate("require stops")
def require_stops(c):
    expect(c.exec("echo first")).to_succeed()
    expect.require(c.exec("false"), "builds").to_succeed()
    c.exec("echo never")


@evaluate("require poll stops")
async def require_poll_stops(c):
    await aio.expect.require.poll(lambda: c.exec("false"), timeout=0.1).to_succeed()
    await c.exec("echo never")


@evaluate("writes and judges")
async def writes_and_judges(c):
    await c.write_file("data.bin", bytes([0, 1]))
    await c.judge("q", diff=True)
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
    host.abort("k1", "canceled", "x")
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


def test_bytes_go_as_base64_and_a_judge_sends_its_inputs(host: Host) -> None:
    host.start("writes and judges")
    assert "error" not in host.done()
    assert host.calls() == [
        {"op": "writeFile", "path": "data.bin", "contents": "AAE=", "encoding": "base64"},
        {"op": "judge", "question": "q", "options": {"diff": True}},
    ]


def test_a_body_the_runner_cancels_without_an_abort_ends_with_an_error() -> None:
    from reeval_python.runner import (
        _canceled_done,  # pyright: ignore[reportPrivateUsage]
        _Connection,  # pyright: ignore[reportPrivateUsage]
    )

    written: list[dict[str, Any]] = []

    class Frames:
        def write(self, msg: dict[str, Any]) -> None:
            written.append(msg)

    conn = _Connection(Frames())  # type: ignore[arg-type]
    _canceled_done(conn, "k1")
    conn.abort("k2", "TimeoutError", "Eval timed out after 1s")
    _canceled_done(conn, "k2")
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


def test_a_failed_require_ends_the_body_with_its_message(host: Host) -> None:
    host.start("require stops")
    assert host.done()["error"]["message"] == "expected command to succeed"
    commands = [c.get("command") for c in host.calls() if c["op"] == "exec"]
    assert commands == ["echo first", "false"]
    expects = [c for c in host.calls() if c["op"] == "expect"]
    assert [(c["soft"], c.get("label")) for c in expects] == [(True, None), (False, "builds")]
    assert all(c["at"]["file"].endswith("x.eval.py") for c in expects), expects
    assert [c["at"]["line"] for c in expects] == [26, 27]


def test_a_failed_require_poll_ends_the_body(host: Host) -> None:
    host.start("require poll stops")
    assert host.done()["error"]["message"] == "expected command to succeed"
    [call] = [c for c in host.calls() if c["op"] == "expect"]
    assert (call["soft"], call["poll"]) == (False, {"timeout": 100})
    assert [c for c in host.calls() if c["op"] == "exec"] == []


def test_expect_has_no_soft() -> None:
    from reeval_python import expect as sync_expect
    from reeval_python.aio import expect as async_expect

    assert not hasattr(sync_expect, "soft")
    assert not hasattr(async_expect, "soft")
    assert not hasattr(sync_expect.require, "require")
