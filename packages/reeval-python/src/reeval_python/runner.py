"""The runner reeval starts: collects declaration trees and runs eval bodies, over stdin/stdout."""

from __future__ import annotations

import asyncio
import inspect
import io
import json
import os
import sys
import threading
import traceback
from contextvars import ContextVar
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, BinaryIO, TextIO, cast

from reeval_python.context import AttemptContext, SyncAttemptContext
from reeval_python.declare import collect_eval_file, get_body
from reeval_python.errors import AttemptAborted, ReevalAssertionError

RUNNER_PROTOCOL = 2

_attempt: ContextVar[str | None] = ContextVar("_attempt", default=None)


def sdk_version() -> str:
    try:
        return version("reeval-python")
    except PackageNotFoundError:
        return "0.0.0"


class _Frames:
    """Writes one JSON message a line to reeval, from the event loop or a sync body's thread."""

    def __init__(self, out: BinaryIO) -> None:
        self._out = out
        self._lock = threading.Lock()

    def write(self, msg: dict[str, Any]) -> None:
        data = (json.dumps(msg) + "\n").encode()
        with self._lock:
            self._out.write(data)
            self._out.flush()


class _Routed(io.TextIOBase):
    """`sys.stdout`/`sys.stderr` in the runner: a body's lines go to its attempt's log."""

    def __init__(self, frames: _Frames, stream: str, fallback: TextIO) -> None:
        self._frames = frames
        self._stream = stream
        self._fallback = fallback
        self._partial: dict[str | None, str] = {}
        self._lock = threading.Lock()

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
        attempt = _attempt.get()
        with self._lock:
            text = self._partial.pop(attempt, "") + s
            *lines, rest = text.split("\n")
            if rest:
                self._partial[attempt] = rest
        for line in lines:
            self._emit(attempt, line)
        return len(s)

    def flush_attempt(self, attempt: str) -> None:
        with self._lock:
            rest = self._partial.pop(attempt, "")
        if rest:
            self._emit(attempt, rest)

    def _emit(self, attempt: str | None, line: str) -> None:
        if attempt is None:
            self._fallback.write(line + "\n")
            self._fallback.flush()
        else:
            self._frames.write(
                {"t": "log", "key": attempt, "stream": self._stream, "text": line}
            )


class _Connection:
    def __init__(self, frames: _Frames) -> None:
        self._frames = frames
        self._pending: dict[tuple[str, str], asyncio.Future[dict[str, Any]]] = {}
        self.aborted: dict[str, AttemptAborted] = {}

    def write(self, msg: dict[str, Any]) -> None:
        self._frames.write(msg)

    def abort(self, key: str, name: str, message: str) -> None:
        """reeval gave up on the body: its calls in flight and every later one raise."""
        aborted = self.aborted[key] = AttemptAborted(name, message)
        for pending in [k for k in self._pending if k[0] == key]:
            fut = self._pending.pop(pending)
            if not fut.done():
                fut.set_exception(aborted)

    def complete_reply(self, msg: dict[str, Any]) -> None:
        attempt = msg.get("key")
        req_id = msg.get("id")
        if attempt is None or req_id is None:
            return
        fut = self._pending.pop((str(attempt), str(req_id)), None)
        if fut is not None and not fut.done():
            fut.set_result(msg)

    async def request(self, attempt_id: str, req_id: str, call: dict[str, Any]) -> dict[str, Any]:
        if attempt_id in self.aborted:
            raise self.aborted[attempt_id]
        fut = asyncio.get_running_loop().create_future()
        self._pending[(attempt_id, req_id)] = fut
        self.write({"id": req_id, "call": call, "key": attempt_id})
        return await fut


async def _run_body(conn: _Connection, attempt_id: str, body_id: str) -> None:
    _attempt.set(attempt_id)
    fn = get_body(body_id)
    seq = 0

    async def send_request(message: dict[str, Any]) -> dict[str, Any]:
        nonlocal seq
        seq += 1
        return await conn.request(attempt_id, str(seq), message["call"])

    loop = asyncio.get_running_loop()
    async_ctx = AttemptContext(attempt_id, send_request)
    error: dict[str, Any] | None = None

    try:
        if inspect.iscoroutinefunction(fn):
            async_ctx.bind_expect()
            await fn(async_ctx)
        else:
            sync_ctx = SyncAttemptContext(async_ctx, loop)
            sync_ctx.bind_expect()
            await asyncio.to_thread(fn, sync_ctx)
    except ReevalAssertionError as exc:
        error = {"name": "AssertionError", "message": str(exc), "stack": traceback.format_exc()}
    except AssertionError as exc:
        stack = traceback.format_exc()
        error = {"name": "AssertionError", "message": str(exc) or "assert failed", "stack": stack}
        try:
            await async_ctx.record_plain_assert(exc)
        except AssertionError as recorded:
            error["message"] = str(recorded)
    except Exception as exc:  # noqa: BLE001
        error = {"name": type(exc).__name__, "message": str(exc), "stack": traceback.format_exc()}
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, _Routed):
            stream.flush_attempt(attempt_id)
    conn.write({"type": "done", "key": attempt_id, **({"error": error} if error else {})})


def _cancelled_done(conn: _Connection, key: str) -> None:
    aborted = conn.aborted.get(key) or AttemptAborted(
        "RunnerError", "the runner stopped this body without reeval aborting it"
    )
    error = {"name": aborted.name, "message": str(aborted)}
    conn.write({"type": "done", "key": key, "error": error})


def _handle(
    msg: dict[str, Any],
    conn: _Connection,
    root: Path,
    tasks: dict[str, asyncio.Task[None]],
) -> None:
    if msg.get("t") == "collect":
        rel = str(msg["file"])
        try:
            conn.write({"t": "declared", "file": rel, "tree": collect_eval_file(root / rel)})
        except Exception as exc:  # noqa: BLE001
            error = {
                "name": type(exc).__name__,
                "message": str(exc),
                "stack": traceback.format_exc(),
            }
            conn.write({"t": "load-error", "error": error})
    elif msg.get("type") == "start":
        key = str(msg["key"])
        task = asyncio.create_task(_run_body(conn, key, str(msg["body"])))
        tasks[key] = task

        def finished(task: asyncio.Task[None], key: str = key) -> None:
            tasks.pop(key, None)
            if task.cancelled():
                _cancelled_done(conn, key)

        task.add_done_callback(finished)
    elif msg.get("type") == "abort":
        if "key" not in msg:
            print(f"reeval sent an abort without a key: {msg}", file=sys.stderr)
            return
        key = str(msg["key"])
        name = "TimeoutError" if msg.get("reason") == "timeout" else "AbortError"
        conn.abort(key, name, str(msg.get("message", "")))
        aborted = tasks.get(key)
        if aborted is not None:
            aborted.cancel()
    elif "id" in msg and "ok" in msg:
        conn.complete_reply(msg)


def _read_lines(
    stdin: BinaryIO, loop: asyncio.AbstractEventLoop, inbox: asyncio.Queue[Any]
) -> None:
    for line in stdin:
        if line.strip():
            loop.call_soon_threadsafe(inbox.put_nowait, json.loads(line))
    loop.call_soon_threadsafe(inbox.put_nowait, None)


async def serve(frames: _Frames, stdin: BinaryIO, root: Path) -> None:
    conn = _Connection(frames)
    frames.write(
        {
            "t": "hello",
            "protocol": RUNNER_PROTOCOL,
            "sdk": "python",
            "version": sdk_version(),
            "runtime": sys.version.split()[0],
        }
    )
    loop = asyncio.get_running_loop()
    inbox: asyncio.Queue[Any] = asyncio.Queue()
    threading.Thread(target=_read_lines, args=(stdin, loop, inbox), daemon=True).start()
    tasks: dict[str, asyncio.Task[None]] = {}
    while (msg := await inbox.get()) is not None:
        _handle(cast(dict[str, Any], msg), conn, root, tasks)


def main() -> None:
    if os.environ.get("REEVAL_RUNNER") != "stdio":
        print("This is reeval's Python runner; run evals with reeval run.", file=sys.stderr)
        sys.exit(2)
    root = Path(os.environ.get("REEVAL_PROJECT_ROOT", os.getcwd()))
    # Frames own a copy of fd 1; fd 1 itself goes to stderr, so a child process's or C
    # extension's output can't land in the middle of a frame.
    sys.stdout.flush()
    frames = _Frames(os.fdopen(os.dup(1), "wb"))
    os.dup2(2, 1)
    real_stderr = sys.__stderr__ or sys.stderr
    sys.stdout = cast(TextIO, _Routed(frames, "stdout", real_stderr))
    sys.stderr = cast(TextIO, _Routed(frames, "stderr", real_stderr))
    asyncio.run(serve(frames, sys.stdin.buffer, root))


if __name__ == "__main__":
    main()
