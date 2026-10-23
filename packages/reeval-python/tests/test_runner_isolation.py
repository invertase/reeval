"""What a body does can't reach the runner's messages: its children, forks, prints and exits."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from stdio_host import Host

READS_STDIN = """
import subprocess
from reeval_python import evaluate


@evaluate("reads stdin")
def reads_stdin(c):
    child = subprocess.Popen(["cat"], stdout=subprocess.DEVNULL)
    try:
        for _ in range(20):
            c.exec("true")
    finally:
        child.kill()
"""


def test_a_child_process_cannot_read_reevals_messages(tmp_path: Path) -> None:
    host = Host(tmp_path, READS_STDIN)
    try:
        host.start("reads stdin")
        assert host.done(timeout=8) == {"type": "done", "key": "k1"}
        assert len(host.calls()) == 20
    finally:
        host.kill()


INPUT = """
import sys
from reeval_python import evaluate


@evaluate("input")
def reads_input(c):
    try:
        input()
    except EOFError:
        print("stdin is empty", sys.stdin.read() == "")
    c.exec("true")
"""


def test_the_bodys_own_input_reads_nothing(tmp_path: Path) -> None:
    host = Host(tmp_path, INPUT)
    try:
        host.start("input")
        assert host.done() == {"type": "done", "key": "k1"}
        assert host.logs() == ["stdin is empty True"]
    finally:
        host.kill()


FORKS = """
import multiprocessing as mp
import os
from reeval_python import evaluate


def spam(tag):
    for _ in range(100):
        print(tag * 20000)


@evaluate("multiprocessing")
def with_multiprocessing(c):
    ps = [mp.get_context("fork").Process(target=spam, args=(t,)) for t in "ab"]
    for p in ps:
        p.start()
    spam("p")
    for p in ps:
        p.join(10)
        assert p.exitcode == 0
    c.exec("true")


@evaluate("os.fork")
def with_fork(c):
    pids = []
    for tag in "cd":
        pid = os.fork()
        if pid == 0:
            spam(tag)
            os._exit(0)
        pids.append(pid)
    spam("q")
    for pid in pids:
        os.waitpid(pid, 0)
    c.exec("true")
"""


@pytest.mark.skipif(sys.platform == "win32", reason="fork is POSIX")
@pytest.mark.parametrize("name", ["multiprocessing", "os.fork"])
def test_forked_children_neither_hang_nor_corrupt_messages(tmp_path: Path, name: str) -> None:
    host = Host(tmp_path, FORKS)
    try:
        host.start(name)
        assert host.done(timeout=30) == {"type": "done", "key": "k1"}
        assert host.bad == [], f"{len(host.bad)} corrupt lines, e.g. {host.bad[0][:60]!r}"
        assert host.logs() == [("p" if name == "multiprocessing" else "q") * 20000] * 100
    finally:
        host.kill()


FILE_API = """
import faulthandler
import subprocess
import sys
from reeval_python import evaluate


@evaluate("file api")
def file_api(c):
    print("encoding", sys.stdout.encoding.lower(), sys.stdout.errors, sys.stdout.isatty())
    sys.stdout.buffer.write("bytes \\u00e9 line\\n".encode())
    subprocess.run(["echo", "child"], stdout=sys.stdout, check=True)
    faulthandler.enable()
    print("crlf\\r")
"""


def test_routed_streams_have_the_file_api(tmp_path: Path) -> None:
    host = Host(tmp_path, FILE_API)
    try:
        host.start("file api")
        assert host.done() == {"type": "done", "key": "k1"}
        assert host.logs() == ["encoding utf-8 backslashreplace False", "bytes é line", "crlf"]
        host.close()
        assert "child" in host.stderr
    finally:
        host.kill()


EXITS = """
import sys
import time
from reeval_python import evaluate


@evaluate("exits")
def exits(c):
    sys.exit(1)


@evaluate("exits async")
async def exits_async(c):
    raise KeyboardInterrupt


@evaluate("innocent")
def innocent(c):
    time.sleep(0.5)
    c.exec("true")
"""


def test_sys_exit_in_one_body_fails_only_that_attempt(tmp_path: Path) -> None:
    host = Host(tmp_path, EXITS)
    try:
        host.start("innocent", "ok")
        host.start("exits", "bad")
        host.start("exits async", "bad-async")
        assert host.done("bad")["error"]["name"] == "SystemExit"
        assert host.done("bad-async")["error"]["name"] == "KeyboardInterrupt"
        assert host.done("ok") == {"type": "done", "key": "ok"}
        assert host.proc.poll() is None, "the runner is still serving"
    finally:
        host.kill()


PROGRESS = """
import asyncio
from reeval_python import evaluate


@evaluate("progress")
def progress(c):
    print("working...", end="", flush=True)
    c.exec("true")


@evaluate("slow")
async def slow(c):
    print("partial", end="")
    await asyncio.sleep(30)
"""


def test_a_flushed_partial_line_is_sent_at_once(tmp_path: Path) -> None:
    host = Host(tmp_path, PROGRESS)
    try:
        host.start("progress")
        host.done()
        kinds = [m.get("t") or ("call" if "call" in m else m.get("type")) for m in host.seen]
        assert kinds[-3:] == ["log", "call", "done"]
    finally:
        host.kill()


def test_an_aborted_body_keeps_its_partial_line(tmp_path: Path) -> None:
    host = Host(tmp_path, PROGRESS)
    try:
        host.start("slow")
        time.sleep(0.3)
        host.abort("k1")
        assert host.done()["error"] == {"name": "TimeoutError", "message": "late"}
        assert host.logs() == ["partial"]
    finally:
        host.kill()


def test_a_line_that_isnt_json_is_reported_and_the_runner_goes_on(tmp_path: Path) -> None:
    host = Host(tmp_path, PROGRESS)
    try:
        host.send_raw(b"not json\n")
        host.start("progress")
        assert host.done() == {"type": "done", "key": "k1"}
        assert host.close(timeout=5) == 0
        assert "isn't JSON" in host.stderr
    finally:
        host.kill()


CONCURRENT = """
import asyncio
from reeval_python import evaluate


@evaluate("sync")
def sync(c):
    for i in range(50):
        print("sync", i)
        c.exec("true")


@evaluate("async")
async def async_(c):
    for i in range(50):
        print("async", i)
        await c.exec("true")
        await asyncio.sleep(0)


@evaluate("odd")
def odd(c):
    print("x" * 2_000_000)
    print("lone \\ud800 surrogate")
    print('{"type": "done"}')
"""


def test_concurrent_bodies_keep_their_own_output(tmp_path: Path) -> None:
    host = Host(tmp_path, CONCURRENT)
    try:
        host.start("sync", "s")
        host.start("async", "a")
        host.start("odd", "o")
        for key in "sao":
            assert "error" not in host.done(key, timeout=30)
        assert host.logs("s") == [f"sync {i}" for i in range(50)]
        assert host.logs("a") == [f"async {i}" for i in range(50)]
        assert host.logs("o") == ["x" * 2_000_000, "lone \ud800 surrogate", '{"type": "done"}']
    finally:
        host.kill()


HANGS = """
import time
from reeval_python import evaluate


@evaluate("hangs")
def hangs(c):
    while True:
        time.sleep(0.1)
"""


def test_the_runner_exits_when_reeval_goes_away_though_a_sync_body_hangs(tmp_path: Path) -> None:
    host = Host(tmp_path, HANGS)
    try:
        host.start("hangs")
        time.sleep(0.3)
        assert host.close(timeout=5) == 0
    finally:
        host.kill()
