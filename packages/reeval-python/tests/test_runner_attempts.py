"""The runner's attempts, with the test as reeval: keys, aborts and the calls bodies make."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

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


class FakeHost:
    """reeval's end of the runner socket: answers every call and keeps what the runner sent."""

    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []
        self.writer: asyncio.StreamWriter | None = None
        self.ready = asyncio.Event()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.writer = writer
        self.ready.set()
        while line := await reader.readline():
            msg = json.loads(line)
            self.seen.append(msg)
            if "call" in msg:
                self.send({"id": msg["id"], "key": msg["key"], **self.reply(msg["call"])})

    @staticmethod
    def reply(call: dict[str, Any]) -> dict[str, Any]:
        op = call["op"]
        if op == "exec":
            failed = call["command"] == "false"
            result = {"exitCode": 1 if failed else 0, "stdout": "", "stderr": ""}
            return {"ok": True, "op": op, "result": result}
        if op == "expect":
            status = "fail" if call["subject"].get("exec") == "false" else "pass"
            assertion = {
                "label": call["matcher"],
                "labelled": False,
                "matcher": call["matcher"],
                "status": status,
                "soft": call["soft"],
            }
            return {"ok": True, "op": op, "assertion": assertion}
        if op == "judge":
            verdict = {"verdict": "pass", "score": 1, "threshold": 0.8, "question": "q"}
            return {"ok": True, "op": op, "verdict": {**verdict, "model": "fake"}}
        return {"ok": True, "op": op}

    def send(self, msg: dict[str, Any]) -> None:
        assert self.writer is not None
        self.writer.write((json.dumps(msg) + "\n").encode())

    def calls(self, key: str) -> list[dict[str, Any]]:
        return [m["call"] for m in self.seen if "call" in m and m["key"] == key]

    def done(self, key: str) -> list[dict[str, Any]]:
        return [m for m in self.seen if m.get("type") == "done" and m["key"] == key]

    async def wait_done(self, key: str) -> dict[str, Any]:
        for _ in range(200):
            if done := self.done(key):
                return done[0]
            await asyncio.sleep(0.02)
        raise AssertionError(f"no done for {key}: {self.seen}")

    async def start_runner(self, root: Path) -> tuple[asyncio.subprocess.Process, dict[str, str]]:
        (root / "x.eval.py").write_text(EVALS)
        server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        env = {
            **os.environ,
            "REEVAL_RUNNER": f"127.0.0.1:{port}",
            "REEVAL_RUNNER_TOKEN": "t",
            "REEVAL_PROJECT_ROOT": str(root),
        }
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "reeval_python", env=env, cwd=root
        )
        await asyncio.wait_for(self.ready.wait(), 10)
        self.send({"t": "collect", "file": "x.eval.py"})
        for _ in range(200):
            declared = [m for m in self.seen if m.get("t") == "declared"]
            if declared:
                return proc, {n["name"]: n["body"] for n in declared[0]["tree"]["children"]}
            await asyncio.sleep(0.02)
        raise AssertionError(f"nothing declared: {self.seen}")


def _start(key: str, body: str) -> dict[str, Any]:
    cell = {"key": "fake/-/fake", "harness": "fake", "environment": "-", "sandbox": "fake"}
    attempt = {"id": "fake/-/fake#1", "cell": {**cell, "role": "control"}, "n": 1}
    return {"type": "start", "key": key, "attempt": attempt, "file": "x.eval.py", "body": body}


def _scenario(tmp_path: Path, body: Any) -> None:
    async def run() -> None:
        host = FakeHost()
        proc, bodies = await host.start_runner(tmp_path)
        try:
            await body(host, bodies)
        finally:
            proc.terminate()
            await proc.wait()

    asyncio.run(run())


def test_two_bodies_on_one_attempt_id_keep_their_own_calls(tmp_path: Path) -> None:
    async def body(host: FakeHost, bodies: dict[str, str]) -> None:
        host.send(_start("k1", bodies["sleeps then calls"]))
        host.send(_start("k2", bodies["calls"]))
        await host.wait_done("k1")
        await host.wait_done("k2")
        assert host.calls("k1") == [{"op": "exec", "command": "echo after-abort"}]
        assert host.calls("k2") == [{"op": "exec", "command": "echo calls"}]

    _scenario(tmp_path, body)


def test_an_abort_stops_only_the_body_it_names(tmp_path: Path) -> None:
    async def body(host: FakeHost, bodies: dict[str, str]) -> None:
        host.send(_start("k1", bodies["sleeps then calls"]))
        host.send(_start("k2", bodies["calls"]))
        host.send({"type": "abort", "key": "k1", "reason": "cancelled", "message": "x"})
        assert "error" not in await host.wait_done("k2")
        assert (await host.wait_done("k1"))["error"] == {"name": "AbortError", "message": "x"}

    _scenario(tmp_path, body)


def test_an_aborted_sync_body_makes_no_more_calls(tmp_path: Path) -> None:
    async def body(host: FakeHost, bodies: dict[str, str]) -> None:
        host.send(_start("k1", bodies["sleeps then calls"]))
        await asyncio.sleep(0.05)
        host.send({"type": "abort", "key": "k1", "reason": "timeout", "message": "late"})
        done = await host.wait_done("k1")
        assert done["error"] == {"name": "TimeoutError", "message": "late"}
        await asyncio.sleep(0.6)
        assert host.calls("k1") == [], "the body's thread called reeval after the abort"

    _scenario(tmp_path, body)


def test_a_soft_failure_lets_the_body_go_on(tmp_path: Path) -> None:
    async def body(host: FakeHost, bodies: dict[str, str]) -> None:
        host.send(_start("k1", bodies["soft then more"]))
        assert "error" not in await host.wait_done("k1")
        commands = [c.get("command") for c in host.calls("k1") if c["op"] == "exec"]
        assert commands == ["false", "echo still-running"]

    _scenario(tmp_path, body)


def test_bytes_go_as_base64_and_a_judge_without_options_sends_none(tmp_path: Path) -> None:
    async def body(host: FakeHost, bodies: dict[str, str]) -> None:
        host.send(_start("k1", bodies["writes and judges"]))
        assert "error" not in await host.wait_done("k1")
        assert host.calls("k1") == [
            {"op": "writeFile", "path": "data.bin", "contents": "AAE=", "encoding": "base64"},
            {"op": "judge", "question": "q"},
        ]

    _scenario(tmp_path, body)


def test_a_body_the_runner_cancels_without_an_abort_ends_with_an_error() -> None:
    from reeval_python.runner import (
        _cancelled_done,  # pyright: ignore[reportPrivateUsage]
        _Connection,  # pyright: ignore[reportPrivateUsage]
    )

    written: list[dict[str, Any]] = []

    class Writer:
        def write(self, data: bytes) -> None:
            written.append(json.loads(data))

    conn = _Connection(Writer())  # type: ignore[arg-type]
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
