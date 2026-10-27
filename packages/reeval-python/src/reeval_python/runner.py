"""The runner reeval starts: collects declaration trees and runs eval bodies, over stdin/stdout."""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import contextvars
import inspect
import io
import itertools
import json
import os
import sys
import threading
import traceback
import weakref
from collections.abc import Mapping
from contextvars import ContextVar
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, BinaryIO, TextIO, cast

from reeval_python._wire import AttemptCall, AttemptCallRecord
from reeval_python.checks import bind_recorder, escaped_failures, only_assertions
from reeval_python.context import AttemptContext, SyncAttemptContext
from reeval_python.declare import collect_eval_file, get_body, is_async
from reeval_python.errors import AttemptAborted, ReevalAssertionError, ReevalCallError
from reeval_python.expect import unawaited

RUNNER_PROTOCOL = 3

_attempt: ContextVar[str | None] = ContextVar("_attempt", default=None)

# The tasks each attempt's body started, by its key: a body that returns leaves none running.
_started: dict[str, weakref.WeakSet[asyncio.Task[Any]]] = {}


def _task_factory(loop: asyncio.AbstractEventLoop, coro: Any, **kwargs: Any) -> asyncio.Task[Any]:
    task: asyncio.Task[Any] = asyncio.Task(coro, loop=loop, **kwargs)
    context = kwargs.get("context")
    key = context.get(_attempt) if context is not None else _attempt.get()
    if key is not None:
        _started.setdefault(key, weakref.WeakSet()).add(task)
    return task


def _left_running(key: str) -> list[asyncio.Task[Any]]:
    """The tasks the body started that are still running, canceled."""
    current = asyncio.current_task()
    left = [t for t in _started.pop(key, ()) if not t.done() and t is not current]
    for task in left:
        task.cancel()
    return left


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
        self.pid = os.getpid()

    def write(self, msg: dict[str, Any]) -> None:
        try:
            data = (json.dumps(msg, allow_nan=False) + "\n").encode()
        except ValueError as exc:
            # reeval can't read a bare NaN, so the call that passed one fails here instead.
            raise ValueError(f"a value isn't JSON, which has no NaN or Infinity: {exc}") from None
        if os.getpid() != self.pid:
            # A forked child (multiprocessing, os.fork) shares the frame fd but not the lock, so
            # its writes would interleave with the runner's: what it says goes to stderr.
            os.write(2, data)
            return
        with self._lock:
            self._out.write(data)
            self._out.flush()


class _RoutedBytes(io.RawIOBase):
    """`sys.stdout.buffer`: bytes written are decoded and routed like text."""

    def __init__(self, text: _Routed) -> None:
        self._text = text
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="backslashreplace")

    def writable(self) -> bool:
        return True

    def write(self, b: Any) -> int:
        data = bytes(b)
        self._text.write(self._decoder.decode(data))
        return len(data)


class _Routed(io.TextIOBase):
    """`sys.stdout`/`sys.stderr` in the runner: a body's lines go to its attempt's log."""

    def __init__(self, frames: _Frames, stream: str, fallback: TextIO) -> None:
        self._frames = frames
        self._stream = stream
        self._fallback = fallback
        self._partial: dict[str | None, str] = {}
        self._lock = threading.Lock()
        self._buffer = _RoutedBytes(self)

    @property
    def encoding(self) -> str:  # pyright: ignore[reportIncompatibleVariableOverride]
        return "utf-8"

    @property
    def errors(self) -> str:  # pyright: ignore[reportIncompatibleVariableOverride]
        return "backslashreplace"

    @property
    def buffer(self) -> _RoutedBytes:  # pyright: ignore[reportIncompatibleVariableOverride]
        return self._buffer

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        # fd 1 and fd 2 both reach reeval's stderr: what writes to the fd (a child process, a C
        # extension, faulthandler) is shown there, unattributed.
        return 2

    def write(self, s: str) -> int:
        if os.getpid() != self._frames.pid:
            os.write(2, s.encode("utf-8", "backslashreplace"))
            return len(s)
        attempt = _attempt.get()
        with self._lock:
            text = self._partial.pop(attempt, "") + s
            *lines, rest = text.split("\n")
            if rest:
                self._partial[attempt] = rest
        for line in lines:
            self._emit(attempt, line.removesuffix("\r"))
        return len(s)

    def flush(self) -> None:
        attempt = _attempt.get()
        if attempt is not None:
            self.flush_attempt(attempt)

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
            self._frames.write({"t": "log", "key": attempt, "stream": self._stream, "text": line})


class _Connection:
    def __init__(self, frames: _Frames) -> None:
        self._frames = frames
        self._pending: dict[tuple[str, str], asyncio.Future[dict[str, Any]]] = {}
        self.aborted: dict[str, AttemptAborted] = {}
        self._records: set[tuple[str, str]] = set()
        self._ended: set[str] = set()
        # Bodies that ended before reeval aborted them: `aborted` holds their refusal of calls.
        self._finished_first: set[str] = set()

    def write(self, msg: dict[str, Any]) -> None:
        self._frames.write(msg)

    def done(self, key: str, error: dict[str, Any] | None = None) -> None:
        self.write({"type": "done", "key": key, **({"error": error} if error else {})})

    def finish(self, key: str) -> None:
        """The body is done: a call it left running, or makes later, raises without reaching
        reeval, and a check made later isn't sent."""
        self._ended.add(key)
        if key not in self.aborted:
            self._finished_first.add(key)
            self.abort(key, "AbortError", "the attempt is over: its body already returned")

    def aborted_by_reeval(self, key: str) -> AttemptAborted | None:
        return None if key in self._finished_first else self.aborted.get(key)

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
        key = (str(attempt), str(req_id))
        if key in self._records:
            self._records.discard(key)
            if not msg.get("ok"):
                error: dict[str, Any] = msg.get("error") or {}
                text = f"reeval refused a check: {error.get('name')}: {error.get('message')}"
                self.write({"t": "log", "key": key[0], "stream": "stderr", "text": text})
            return
        fut = self._pending.pop(key, None)
        if fut is not None and not fut.done():
            fut.set_result(msg)

    def record(self, attempt_id: str, req_id: str, call: AttemptCallRecord) -> None:
        """Sends a check without waiting for reeval's answer, which only a refusal is shown of."""
        # A thread that outlived its body checks after the attempt's outcome is settled.
        if attempt_id in self._ended:
            return
        if attempt_id in self.aborted:
            raise self.aborted[attempt_id]
        self._records.add((attempt_id, req_id))
        self.write({"id": req_id, "call": call, "key": attempt_id})

    async def request(self, attempt_id: str, req_id: str, call: AttemptCall) -> dict[str, Any]:
        if attempt_id in self.aborted:
            raise self.aborted[attempt_id]
        fut = asyncio.get_running_loop().create_future()
        self._pending[(attempt_id, req_id)] = fut
        try:
            self.write({"id": req_id, "call": call, "key": attempt_id})
        except BaseException:
            self._pending.pop((attempt_id, req_id), None)
            raise
        return await fut


async def _in_thread(fn: Any, *args: Any) -> Any:
    """Runs a sync body on a thread of its own, in the caller's context.

    Not the default executor: a body that never returns would hold one of its few workers, and
    keep the runner alive after reeval goes away (a daemon thread doesn't), and a child forked
    from an executor's thread fails at exit joining that thread.
    """
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[Any] = loop.create_future()
    ctx = contextvars.copy_context()

    def settle(error: BaseException | None, result: Any) -> None:
        if fut.done():
            return
        if error is None:
            fut.set_result(result)
        else:
            fut.set_exception(error)

    def run() -> None:
        try:
            result = ctx.run(fn, *args)
        except BaseException as exc:  # noqa: BLE001
            outcome: tuple[BaseException | None, Any] = (exc, None)
        else:
            outcome = (None, result)
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(settle, *outcome)

    threading.Thread(target=run, name="reeval-body", daemon=True).start()
    return await fut


async def _run_body(conn: _Connection, attempt_id: str, body_id: str) -> None:
    _attempt.set(attempt_id)
    fn = get_body(body_id)
    # One numbering for the body's requests and records (a sync body records from its thread).
    ids = itertools.count(1)

    async def send_request(call: AttemptCall) -> dict[str, Any]:
        return await conn.request(attempt_id, str(next(ids)), call)

    loop = asyncio.get_running_loop()
    async_ctx = AttemptContext(attempt_id, send_request)
    error: dict[str, Any] | None = None

    def record(call: AttemptCallRecord) -> None:
        conn.record(attempt_id, str(next(ids)), call)

    bind_recorder(record)
    try:
        if is_async(fn):
            async_ctx.bind_expect()
            result = fn(async_ctx)
            if inspect.isawaitable(result):
                await result
            if left := _left_running(attempt_id):
                raise ReevalCallError(
                    "UsageError",
                    f"the body returned with {len(left)} task(s) it started still running, so "
                    "their calls and checks were cut short: await each task (asyncio.gather or "
                    "a TaskGroup) before the body returns",
                )
            if never_awaited := unawaited():
                raise ReevalCallError(
                    "UsageError",
                    f"{never_awaited[0]} was never awaited, so it didn't run: an async body "
                    "awaits each c call and matcher",
                )
        else:
            sync_ctx = SyncAttemptContext(async_ctx, loop)
            sync_ctx.bind_expect()
            result = await _in_thread(fn, sync_ctx)
            if inspect.isgenerator(result) or inspect.isasyncgen(result):
                raise ReevalCallError(
                    "UsageError",
                    "the eval body is a generator, so it never ran: declare it def or async def "
                    "without yield",
                )
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                raise ReevalCallError(
                    "UsageError",
                    "the eval body is a plain function that returned an awaitable, which never "
                    "ran: declare the body `async def`, and keep functools.wraps on any "
                    "decorator around it",
                )
    except asyncio.CancelledError:
        _left_running(attempt_id)
        unawaited()
        conn.finish(attempt_id)
        _flush(attempt_id)
        raise
    except AttemptAborted as exc:
        error = {"name": exc.name, "message": str(exc)}
    except ReevalCallError as exc:
        error = {"name": exc.name, "message": str(exc), "stack": traceback.format_exc()}
    except BaseException as exc:  # noqa: BLE001
        # SystemExit and the like end this body only: the runner serves other attempts too.
        failures = escaped_failures(exc)
        # Once reeval has aborted the attempt it has settled it, and refuses the records.
        with contextlib.suppress(AttemptAborted):
            for call in failures:
                record(call)
        if only_assertions(exc):
            own = failures if not isinstance(exc, ReevalAssertionError) else []
            message = "\n".join(c.get("message", "") for c in own) if own else str(exc)
            error = {"name": "AssertionError", "message": message}
        else:
            error = {"name": type(exc).__name__, "message": str(exc)}
        error["stack"] = traceback.format_exc()
    _left_running(attempt_id)
    unawaited()
    conn.finish(attempt_id)
    _flush(attempt_id)
    conn.done(attempt_id, error)


def _flush(key: str) -> None:
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, _Routed):
            stream.flush_attempt(key)


# What stopped the runner's loop, when something did: a `SystemExit` or `KeyboardInterrupt`
# from a task a body started gets past the body and out of the loop.
_escaped: BaseException | None = None


def _canceled_done(conn: _Connection, key: str) -> None:
    aborted = conn.aborted_by_reeval(key)
    if aborted is None and _escaped is not None:
        aborted = AttemptAborted(
            type(_escaped).__name__,
            f"a task a body started raised {_escaped!r}, which stopped the runner this attempt "
            "ran in",
        )
    if aborted is None:
        aborted = AttemptAborted(
            "RunnerError", "the runner stopped this body without reeval aborting it"
        )
    error = {"name": aborted.name, "message": str(aborted)}
    conn.done(key, error)


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
                _canceled_done(conn, key)

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
    try:
        for line in stdin:
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                print(f"reeval sent a line that isn't JSON: {line[:200]!r}", file=sys.stderr)
                continue
            loop.call_soon_threadsafe(inbox.put_nowait, msg)
    except BaseException:  # noqa: BLE001
        traceback.print_exc()
    finally:
        with contextlib.suppress(RuntimeError):
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
    loop.set_task_factory(_task_factory)
    inbox: asyncio.Queue[Any] = asyncio.Queue()
    threading.Thread(target=_read_lines, args=(stdin, loop, inbox), daemon=True).start()
    tasks: dict[str, asyncio.Task[None]] = {}
    while (msg := await inbox.get()) is not None:
        _handle(cast(dict[str, Any], msg), conn, root, tasks)
    # reeval has gone: a body still running ends aborted rather than unreported. A sync body's
    # thread can't be stopped, so the wait is bounded and the process ends with os._exit.
    running = list(tasks.items())
    for key, task in running:
        conn.abort(key, "AbortError", "reeval closed the runner before this body ended")
        task.cancel()
    if running:
        await asyncio.wait([task for _, task in running], timeout=2)


def _mismatch(env: Mapping[str, str]) -> str | None:
    """Why this runner can't serve the reeval that started it, or None when it can."""
    started_by = env.get("REEVAL_RUNNER")
    if started_by is None:
        return "This is reeval's Python runner; run evals with reeval run."
    ours = f"reeval-python {sdk_version()} speaks runner protocol {RUNNER_PROTOCOL}"
    if started_by != "stdio":
        return f"{ours}, but the reeval that started it is older: use the reeval that matches it."
    theirs = env.get("REEVAL_RUNNER_PROTOCOL")
    if theirs != str(RUNNER_PROTOCOL):
        return (
            f"{ours}, but the reeval that started it speaks {theirs or 'an older one'}: "
            "use the reeval-python version that matches reeval."
        )
    return None


def main() -> None:
    if (problem := _mismatch(os.environ)) is not None:
        print(problem, file=sys.stderr)
        sys.exit(2)
    root = Path(os.environ.get("REEVAL_PROJECT_ROOT", os.getcwd()))
    # The runner keeps private copies of fd 0 and fd 1 for messages (os.dup's are
    # non-inheritable). fd 1 itself goes to stderr and fd 0 reads /dev/null, so a child process,
    # a C extension or the body's own input() can neither write into a message nor read one.
    sys.stdout.flush()
    frames = _Frames(os.fdopen(os.dup(1), "wb"))
    messages = os.fdopen(os.dup(0), "rb")
    os.dup2(2, 1)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(os.devnull, encoding="utf-8")  # noqa: SIM115
    real_stderr = sys.__stderr__ or sys.stderr
    sys.stdout = cast(TextIO, _Routed(frames, "stdout", real_stderr))
    sys.stderr = cast(TextIO, _Routed(frames, "stderr", real_stderr))
    code = _serve_contained(frames, messages, root)
    real_stderr.flush()
    # Not sys.exit: a thread or executor a body left running would keep the process alive
    # after reeval has gone.
    os._exit(code)


def _serve_contained(frames: _Frames, messages: BinaryIO, root: Path) -> int:
    """Serves until reeval closes stdin (0), or something stops the loop (1): every body still
    running then ends with an error naming it."""
    global _escaped
    # Never closed: closing joins the default executor's threads, which a body may have left
    # sleeping. The process ends with os._exit instead.
    runner = asyncio.Runner()
    try:
        runner.run(serve(frames, messages, root))
    except BaseException as exc:  # noqa: BLE001
        _escaped = exc
        traceback.print_exception(exc)
        loop = runner.get_loop()
        left = asyncio.all_tasks(loop)
        for task in left:
            task.cancel()
        loop.run_until_complete(asyncio.gather(*left, return_exceptions=True))
        return 1
    return 0


if __name__ == "__main__":
    main()
