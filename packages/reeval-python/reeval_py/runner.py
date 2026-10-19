"""Out-of-process runner: collect declaration trees and run eval bodies over attempt protocol v2."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from reeval_py.context import AttemptContext
import reeval_py.declare as decl
from reeval_py.declare import get_body

RUNNER_PROTOCOL = 2
SDK_VERSION = "0.0.0"


def _load_eval_file(path: Path) -> None:
    decl.reset_collector()
    spec = importlib.util.spec_from_file_location("reeval_eval", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"can't load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


def _collect_suite_sync(suite) -> None:
    if suite.factory is not None:
        suite.factory()
    for nested in suite.suites:
        _collect_suite_sync(nested)


def _tree_for_file(root: Path, rel: str) -> dict[str, Any]:
    _load_eval_file(root / rel)
    _collect_suite_sync(decl._suites[0])
    assert decl._tree_children is not None
    return {"children": [c.as_json() for c in decl._tree_children]}


class _Connection:
    def __init__(self, writer: asyncio.StreamWriter) -> None:
        self._writer = writer
        self._pending: dict[tuple[str, str], asyncio.Future[dict[str, Any]]] = {}

    def write(self, msg: dict[str, Any]) -> None:
        self._writer.write((json.dumps(msg) + "\n").encode())

    async def drain(self) -> None:
        await self._writer.drain()

    def complete_reply(self, msg: dict[str, Any]) -> None:
        attempt = msg.get("attempt")
        req_id = msg.get("id")
        if attempt is None or req_id is None:
            return
        key = (str(attempt), str(req_id))
        fut = self._pending.pop(key, None)
        if fut is not None and not fut.done():
            fut.set_result(msg)

    async def request(self, attempt_id: str, req_id: str, call: dict[str, Any]) -> dict[str, Any]:
        key = (attempt_id, req_id)
        fut = asyncio.get_running_loop().create_future()
        self._pending[key] = fut
        self.write({"id": req_id, "call": call, "attempt": attempt_id})
        await self.drain()
        return await fut


async def _run_body(conn: _Connection, attempt_id: str, body_id: str) -> None:
    fn = get_body(body_id)
    seq = 0

    async def send_request(message: dict[str, Any]) -> dict[str, Any]:
        nonlocal seq
        seq += 1
        req_id = str(seq)
        return await conn.request(attempt_id, req_id, message["call"])

    ctx = AttemptContext(attempt_id, send_request)
    error: dict[str, Any] | None = None
    try:
        result = fn(ctx)
        if asyncio.iscoroutine(result):
            await result
    except Exception as exc:  # noqa: BLE001
        error = {"name": type(exc).__name__, "message": str(exc), "stack": traceback.format_exc()}
    conn.write({"type": "done", "attempt": attempt_id, **({"error": error} if error else {})})
    await conn.drain()


async def serve() -> None:
    host_port = os.environ.get("REEVAL_RUNNER", "")
    token = os.environ.get("REEVAL_RUNNER_TOKEN", "")
    root = Path(os.environ.get("REEVAL_PROJECT_ROOT", os.getcwd()))
    if ":" not in host_port or not token:
        print("This is reeval's Python runner; run evals with reeval run.", file=sys.stderr)
        sys.exit(2)

    host, port_str = host_port.rsplit(":", 1)
    reader, writer = await asyncio.open_connection(host, int(port_str))
    conn = _Connection(writer)

    hello = {
        "t": "hello",
        "protocol": RUNNER_PROTOCOL,
        "token": token,
        "sdk": "python",
        "version": SDK_VERSION,
        "runtime": sys.version.split()[0],
    }
    writer.write((json.dumps(hello) + "\n").encode())
    await writer.drain()

    tasks: set[asyncio.Task[None]] = set()
    buf = b""
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            msg = json.loads(line.decode())
            if msg.get("t") == "collect":
                rel = msg["file"]
                try:
                    tree = _tree_for_file(root, rel)
                    conn.write({"t": "declared", "file": rel, "tree": tree})
                except Exception as exc:  # noqa: BLE001
                    conn.write(
                        {
                            "t": "load-error",
                            "error": {
                                "name": type(exc).__name__,
                                "message": str(exc),
                                "stack": traceback.format_exc(),
                            },
                        }
                    )
                await conn.drain()
            elif msg.get("type") == "start":
                attempt_id = msg["attempt"]["id"]
                body_id = msg["body"]
                task = asyncio.create_task(_run_body(conn, attempt_id, body_id))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
            elif msg.get("type") == "abort":
                for task in list(tasks):
                    task.cancel()
            elif "id" in msg and "ok" in msg:
                conn.complete_reply(msg)

    writer.close()


def main() -> None:
    asyncio.run(serve())


if __name__ == "__main__":
    main()
