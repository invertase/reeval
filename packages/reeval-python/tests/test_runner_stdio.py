"""The runner as reeval starts it: messages on stdin/stdout, prints routed to their attempt."""

from __future__ import annotations

from pathlib import Path

from stdio_host import Host

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
            "protocol": 2,
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
