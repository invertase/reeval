"""The SDK's calls through a real runner: a check that never ran fails its body, values reach
reeval as JSON, and an aborted body makes no more calls whatever it catches."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from stdio_host import Host

from reeval_python.runner import _Connection  # pyright: ignore[reportPrivateUsage]

EVAL = """
import contextlib
import functools
from reeval_python import evaluate
from reeval_python.aio import expect


def traced(fn):
    @functools.wraps(fn)
    def inner(c):
        return fn(c)
    return inner


def unwrapped(fn):
    def inner(c):
        return fn(c)
    return inner


@evaluate("sync expect in an async body")
async def mixes(c):
    import reeval_python
    reeval_python.expect(1).to_be(1)


@evaluate("forgets an await")
async def forgets(c):
    expect(1).to_be(2)


@evaluate("wrapped async")
@traced
async def wrapped(c):
    await expect(await c.exec("true")).to_succeed()


@evaluate("wrapped without wraps")
@unwrapped
async def bare(c):
    await expect(await c.exec("true")).to_succeed()


@evaluate("judges an exec result")
async def judges(c):
    result = await c.exec("true")
    await c.judge("clean?", on=result, output=True)
    await c.judge("null?", on=None, output=True)


@evaluate("judges a set")
async def judges_a_set(c):
    await c.judge("set?", on={1, 2}, output=True)


@evaluate("judges nothing")
async def judges_nothing(c):
    await c.judge("anything?", threshold=0.5, diff=False)


@evaluate("catches the abort")
async def catches(c):
    try:
        await c.exec("sleep 20")
    except Exception:
        pass
    await c.exec("echo after")


@evaluate("swallows the abort")
async def swallows(c):
    try:
        await c.exec("sleep 20")
    except BaseException:
        pass
    await c.exec("echo after")


@evaluate("catches the abort in sync")
def catches_sync(c):
    try:
        c.exec("sleep 20")
    except BaseException:
        pass
    c.exec("echo after")
"""


@pytest.fixture
def host(tmp_path: Path):  # pyright: ignore[reportUnknownParameterType]
    h = Host(tmp_path, EVAL)
    yield h
    h.kill()


@pytest.fixture
def silent(tmp_path: Path):  # pyright: ignore[reportUnknownParameterType]
    h = Host(tmp_path, EVAL, answer=False)
    yield h
    h.kill()


def test_a_matcher_never_awaited_fails_the_body(host: Host) -> None:
    host.start("forgets an await")
    error = host.done()["error"]
    assert error["name"] == "UsageError"
    assert "to_be() was never awaited" in error["message"]
    assert host.calls() == []


def test_the_sync_expect_in_an_async_body_says_which_to_use(host: Host) -> None:
    host.start("sync expect in an async body")
    error = host.done()["error"]
    assert "use reeval_python.aio's and await the matcher" in error["message"]
    assert host.calls() == []


def test_an_async_body_under_a_wrapping_decorator_runs(host: Host) -> None:
    host.start("wrapped async")
    assert "error" not in host.done()
    assert [c["op"] for c in host.calls()] == ["exec", "expect"]


def test_a_sync_wrapper_that_returns_a_coroutine_fails_the_body(host: Host) -> None:
    host.start("wrapped without wraps")
    error = host.done()["error"]
    assert error["name"] == "UsageError"
    assert "returned an awaitable" in error["message"]


def test_judge_on_an_exec_result_or_none_sends_their_values(host: Host) -> None:
    host.start("judges an exec result")
    assert "error" not in host.done()
    judges = [c for c in host.calls() if c["op"] == "judge"]
    assert [j["options"]["on"] for j in judges] == [
        {"value": {"exitCode": 0, "stdout": "", "stderr": ""}},
        {"value": None},
    ]


def test_judge_on_a_value_that_is_not_json_fails_where_it_was_passed(host: Host) -> None:
    host.start("judges a set")
    error = host.done()["error"]
    assert error["name"] == "TypeError"
    assert "judge(on=…) takes" in error["message"]
    assert host.calls() == []


def test_judge_that_turns_no_input_on_fails_before_it_reaches_reeval(host: Host) -> None:
    host.start("judges nothing")
    error = host.done()["error"]
    assert error["name"] == "TypeError"
    assert "shows the judge nothing" in error["message"]
    assert (
        "task, output, files, diff, contents, transcript, checks, observations or artifacts"
        in error["message"]
    )
    assert host.calls() == []


@pytest.mark.parametrize("body", ["catches the abort", "swallows the abort"])
def test_an_aborted_body_makes_no_more_calls_whatever_it_catches(silent: Host, body: str) -> None:
    silent.start(body)
    silent.wait(lambda m: "call" in m)
    silent.abort("k1", "timeout", "Eval timed out after 1s")
    done = silent.done()
    assert done["error"] == {"name": "TimeoutError", "message": "Eval timed out after 1s"}
    time.sleep(0.2)
    assert silent.calls() == [{"op": "exec", "command": "sleep 20"}]


def test_an_aborted_sync_body_that_catches_makes_no_more_calls(silent: Host) -> None:
    silent.start("catches the abort in sync")
    silent.wait(lambda m: "call" in m)
    silent.abort("k1", "timeout", "late")
    assert silent.done()["error"]["name"] == "TimeoutError"
    time.sleep(0.2)
    assert silent.calls() == [{"op": "exec", "command": "sleep 20"}]


def test_a_body_still_running_when_reeval_goes_away_ends_aborted(silent: Host) -> None:
    silent.start("catches the abort")
    silent.wait(lambda m: "call" in m)
    assert silent.close() == 0
    assert silent.done()["error"]["name"] == "AbortError"


class _Unwritable:
    def write(self, msg: object) -> None:
        raise TypeError("Object of type set is not JSON serializable")


def test_a_call_that_cannot_be_written_leaves_nothing_pending() -> None:
    conn = _Connection(_Unwritable())  # pyright: ignore[reportArgumentType]

    async def go() -> None:
        with pytest.raises(TypeError):
            await conn.request("k1", "1", {"op": "exec", "command": "true"})

    asyncio.run(go())
    assert conn._pending == {}  # pyright: ignore[reportPrivateUsage]
