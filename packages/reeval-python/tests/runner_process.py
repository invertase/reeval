"""The Python runner as reeval starts it, with the test as reeval: messages on stdin and stdout."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

SRC = Path(__file__).resolve().parents[1] / "src"

ATTEMPT: dict[str, Any] = {
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


class Runner:
    def __init__(self, root: Path) -> None:
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
        self.logs: list[dict[str, Any]] = []
        hello = self.read()
        assert hello["t"] == "hello", hello

    def send(self, msg: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()

    def read(self) -> dict[str, Any]:
        """The next message that isn't a log line (those are kept in `logs`)."""
        assert self.proc.stdout is not None
        while True:
            line = self.proc.stdout.readline()
            assert line, f"the runner closed its stdout:\n{self.stderr()}"
            msg = json.loads(line)
            if msg.get("t") != "log":
                return msg
            self.logs.append(msg)

    def collect(self, file: str) -> dict[str, Any]:
        self.send({"t": "collect", "file": file})
        declared = self.read()
        assert declared["t"] == "declared", declared
        return declared["tree"]

    def stderr(self) -> str:
        assert self.proc.stderr is not None
        self.proc.kill()
        return self.proc.stderr.read().decode()

    def close(self) -> str:
        assert self.proc.stdin is not None and self.proc.stderr is not None
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        return self.proc.stderr.read().decode()
