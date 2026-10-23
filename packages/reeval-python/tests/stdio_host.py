"""reeval's end of the runner, for tests: starts the runner on stdin/stdout and answers its calls.

Reads on a thread, so a runner that hangs fails the test that waits on it instead of the suite.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

SRC = Path(__file__).resolve().parents[1] / "src"

ATTEMPT = {
    "id": "fake/-/fake#1",
    "cell": {
        "key": "fake/-/fake",
        "harness": "fake",
        "environment": "-",
        "sandbox": "fake",
        "role": "control",
    },
    "n": 1,
}


def reply_to(call: dict[str, Any]) -> dict[str, Any]:
    """reeval's answer to a call, as the fake sandbox gives it: `false` fails, the rest pass."""
    op = call["op"]
    if op == "exec":
        failed = call["command"] == "false"
        result = {"exitCode": 1 if failed else 0, "stdout": "", "stderr": ""}
        return {"ok": True, "op": op, "result": result}
    if op == "expect":
        failed = call["subject"].get("exec") == "false"
        assertion = {
            "label": call["matcher"],
            "labelled": False,
            "matcher": call["matcher"],
            "status": "fail" if failed else "pass",
            "soft": call["soft"],
            **({"message": "expected command to succeed"} if failed else {}),
        }
        return {"ok": True, "op": op, "assertion": assertion}
    if op == "judge":
        verdict = {"verdict": "pass", "score": 1, "threshold": 0.8, "question": call["question"]}
        return {"ok": True, "op": op, "verdict": {**verdict, "model": "fake"}}
    return {"ok": True, "op": op}


class Host:
    def __init__(self, root: Path, source: str, *, answer: bool = True) -> None:
        (root / "evals").mkdir(exist_ok=True)
        (root / "evals" / "x.eval.py").write_text(source)
        env = {**os.environ, "REEVAL_RUNNER": "stdio", "REEVAL_PROJECT_ROOT": str(root)}
        env["PYTHONPATH"] = os.pathsep.join([str(SRC), env.get("PYTHONPATH", "")])
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "reeval_python"],
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.answer = answer
        self.seen: list[dict[str, Any]] = []
        self.bad: list[bytes] = []
        self.closed = False
        self._stderr: list[bytes] = []
        self._cond = threading.Condition()
        self._write = threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._drain, daemon=True).start()
        self.hello = self.wait(lambda m: m.get("t") == "hello")
        self.send({"t": "collect", "file": "evals/x.eval.py"})
        declared = self.wait(lambda m: m.get("t") in ("declared", "load-error"))
        assert declared["t"] == "declared", declared
        self.bodies = {n["name"]: n["body"] for n in declared["tree"]["children"]}

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                self.bad.append(line[:200])
                continue
            with self._cond:
                self.seen.append(msg)
                self._cond.notify_all()
            if "call" in msg and self.answer:
                self.send({"id": msg["id"], "key": msg["key"], **reply_to(msg["call"])})
        with self._cond:
            self.closed = True
            self._cond.notify_all()

    def _drain(self) -> None:
        assert self.proc.stderr is not None
        for chunk in iter(lambda: self.proc.stderr.read1(65536), b""):  # type: ignore[union-attr]
            self._stderr.append(chunk)

    @property
    def stderr(self) -> str:
        return b"".join(self._stderr).decode(errors="replace")

    def send(self, msg: dict[str, Any]) -> None:
        self.send_raw((json.dumps(msg) + "\n").encode())

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        with self._write:
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
            except (BrokenPipeError, ValueError):
                pass

    def wait(
        self, pred: Callable[[dict[str, Any]], bool], timeout: float = 10
    ) -> dict[str, Any]:
        end = time.monotonic() + timeout
        with self._cond:
            while True:
                for msg in self.seen:
                    if pred(msg):
                        return msg
                left = end - time.monotonic()
                if left <= 0 or self.closed:
                    tail = self.seen[-5:]
                    raise AssertionError(f"not seen within {timeout}s; last: {tail}{self.stderr}")
                self._cond.wait(left)

    def start(self, name: str, key: str = "k1") -> None:
        msg = {"type": "start", "key": key, "attempt": ATTEMPT, "file": "evals/x.eval.py"}
        self.send({**msg, "body": self.bodies[name]})

    def abort(self, key: str, reason: str = "timeout", message: str = "late") -> None:
        self.send({"type": "abort", "key": key, "reason": reason, "message": message})

    def done(self, key: str = "k1", timeout: float = 10) -> dict[str, Any]:
        return self.wait(lambda m: m.get("type") == "done" and m.get("key") == key, timeout)

    def calls(self, key: str = "k1") -> list[dict[str, Any]]:
        with self._cond:
            return [m["call"] for m in self.seen if "call" in m and m["key"] == key]

    def logs(self, key: str | None = "k1") -> list[str]:
        with self._cond:
            return [m["text"] for m in self.seen if m.get("t") == "log" and m.get("key") == key]

    def close(self, timeout: float = 10) -> int:
        """Closes stdin as reeval does when it exits, and waits for the runner to end."""
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        return self.proc.wait(timeout=timeout)

    def kill(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
