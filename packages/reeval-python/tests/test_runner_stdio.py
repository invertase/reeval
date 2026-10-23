"""The runner as reeval starts it: messages on stdin/stdout, prints routed to their attempt."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from stdio_host import SRC, Host

EVAL = """
import subprocess
from reeval_python import evaluate

print("collected")


@evaluate("prints")
def prints(c):
    print("before", end="")
    print(" the call")
    subprocess.run(["echo", "from a child process"], check=True)
    c.exec("true")
    print("after")
"""


def test_runner_speaks_over_stdio_and_routes_prints(tmp_path: Path) -> None:
    host = Host(tmp_path, EVAL)
    try:
        assert {k: host.hello[k] for k in ("t", "protocol", "sdk")} == {
            "t": "hello",
            "protocol": 3,
            "sdk": "python",
        }
        assert list(host.bodies) == ["prints"]
        host.start("prints")
        assert host.done() == {"type": "done", "key": "k1"}
        assert host.calls() == [{"op": "exec", "command": "true"}]
        assert host.logs() == ["before the call", "after"]
        assert host.close() == 0
        assert "collected" in host.stderr, "output outside a body goes to stderr"
        assert "from a child process" in host.stderr, "a child process can't write into a message"
    finally:
        host.kill()


def _refusal(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    base = {k: v for k, v in os.environ.items() if not k.startswith("REEVAL_RUNNER")}
    base["PYTHONPATH"] = str(SRC)
    return subprocess.run(
        # The runner itself: without REEVAL_RUNNER, `python -m reeval_python` is `reeval`.
        [sys.executable, "-c", "from reeval_python.runner import main; main()"],
        env={**base, **env},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


@pytest.mark.parametrize(
    ("env", "says"),
    [
        ({}, "run evals with reeval run"),
        ({"REEVAL_RUNNER": "127.0.0.1:4000"}, "the reeval that started it is older"),
        ({"REEVAL_RUNNER": "stdio"}, "speaks an older one"),
        ({"REEVAL_RUNNER": "stdio", "REEVAL_RUNNER_PROTOCOL": "4"}, "speaks 4"),
    ],
)
def test_a_runner_on_another_protocol_says_so_instead_of_hello(
    env: dict[str, str], says: str
) -> None:
    done = _refusal(env)
    assert done.returncode == 2
    assert done.stdout == ""
    assert says in done.stderr, done.stderr


SLEEPS = """
import asyncio
from reeval_python import evaluate


@evaluate("sleeps")
async def sleeps(c):
    await asyncio.sleep(30)
"""


def test_an_abort_between_calls_ends_the_body(tmp_path: Path) -> None:
    host = Host(tmp_path, SLEEPS)
    try:
        host.start("sleeps")
        host.abort("k1", "timeout", "Eval timed out after 1s")
        error = {"name": "TimeoutError", "message": "Eval timed out after 1s"}
        assert host.done() == {"type": "done", "key": "k1", "error": error}
        assert host.close() == 0
    finally:
        host.kill()
