"""Bodies that would pass without running their checks: each fails its attempt instead."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from stdio_host import Host

EVAL = '''
import asyncio
from reeval_python import aio, evaluate, expect


def hidden(fn):
    """A decorator without functools.wraps, so reeval can't see the body is a generator."""
    return lambda c: fn(c)


@evaluate("async generator body")
@hidden
async def agen(c):
    await aio.expect(1).to_be(2)
    yield


@evaluate("sync generator body")
@hidden
def gen(c):
    expect(1).to_be(2)
    yield


@evaluate("unawaited write_file")
async def unawaited_write(c):
    c.write_file("config.json", "{}")
    await c.exec("true")


@evaluate("unawaited send")
async def unawaited_send(c):
    c.send("do the task")


@evaluate("orphan task matcher")
async def orphan(c):
    asyncio.get_running_loop().create_task(aio.expect(await c.exec("false")).to_succeed())
    await asyncio.sleep(0)


@evaluate("orphan task exec after done")
async def orphan_exec(c):
    async def later():
        await asyncio.sleep(0.2)
        await c.exec("rm -rf build")

    asyncio.get_running_loop().create_task(later())


@evaluate("awaited task")
async def awaited_task(c):
    task = asyncio.get_running_loop().create_task(c.exec("true"))
    await asyncio.gather(task, c.exec("true"))


@evaluate("sync poll read")
def sync_poll_read(c):
    expect.poll(lambda: c.read_file("ready.txt"), timeout=0.5).to_be("ready")


@evaluate("sync poll exec")
def sync_poll_exec(c):
    expect.poll(lambda: c.exec("test -f ready.txt"), interval=0.05).to_succeed()


@evaluate("sync poll attribute")
def sync_poll_attr(c):
    expect.poll(lambda: c.exec("cat x").stdout).to_contain("ok")


@evaluate("sync poll or")
def sync_poll_or(c):
    expect.poll(lambda: c.read_file("a") or c.read_file("b")).to_be("x")


@evaluate("aio expect in sync body")
def aio_in_sync(c):
    aio.expect(1).to_be(1)
'''


@pytest.fixture
def host(tmp_path: Path):  # pyright: ignore[reportUnknownParameterType]
    h = Host(tmp_path, EVAL)
    yield h
    h.kill()


@pytest.mark.parametrize("body", ["async generator body", "sync generator body"])
def test_a_generator_body_fails_rather_than_passing_unrun(host: Host, body: str) -> None:
    host.start(body)
    error = host.done()["error"]
    assert "generator, so it never ran" in error["message"], error
    assert host.calls() == []


@pytest.mark.parametrize(
    ("body", "call"), [("unawaited write_file", "c.write_file()"), ("unawaited send", "c.send()")]
)
def test_an_unawaited_call_fails_the_body(host: Host, body: str, call: str) -> None:
    host.start(body)
    error = host.done()["error"]
    assert error["message"].startswith(f"{call} was never awaited, so it didn't run"), error
    assert all(c["op"] not in ("writeFile", "send") for c in host.calls())
    assert "RuntimeWarning" not in host.stderr


def test_a_task_left_running_fails_the_body_and_its_check_is_not_lost(host: Host) -> None:
    host.start("orphan task matcher")
    error = host.done()["error"]
    assert "1 task(s) it started still running" in error["message"], error


def test_a_task_left_running_makes_no_call_after_done(host: Host) -> None:
    host.start("orphan task exec after done")
    assert "error" in host.done()
    seen = len(host.seen)
    time.sleep(0.5)
    assert [m for m in host.seen[seen:] if "call" in m] == []


def test_a_task_the_body_awaits_is_fine(host: Host) -> None:
    host.start("awaited task")
    assert host.done() == {"type": "done", "key": "k1"}


def test_sync_poll_sends_the_read_or_command_and_seconds_as_ms(host: Host) -> None:
    host.start("sync poll read")
    host.done()
    [read] = host.calls()
    assert (read["subject"], read["poll"]) == ({"readFile": "ready.txt"}, {"timeout": 500})
    host.start("sync poll exec", "k2")
    host.done("k2")
    [run] = host.calls("k2")
    assert (run["subject"], run["poll"]) == ({"exec": "test -f ready.txt"}, {"interval": 50})


def test_sync_poll_attribute_says_what_to_do(host: Host) -> None:
    host.start("sync poll attribute")
    message = host.done()["error"]["message"]
    assert "expect.poll's function returns c.read_file(…) or c.exec(…) itself" in message


def test_sync_poll_of_two_reads_is_refused(host: Host) -> None:
    host.start("sync poll or")
    assert "check its contents or output with a matcher" in host.done()["error"]["message"]
    assert host.calls() == []


def test_aio_expect_in_a_sync_body_is_refused(host: Host) -> None:
    host.start("aio expect in sync body")
    assert "in a def body" in host.done()["error"]["message"]
