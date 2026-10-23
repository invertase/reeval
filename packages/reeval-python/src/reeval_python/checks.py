"""Plain `assert` in an eval file: each one, passing or failing, is a check in the attempt record.

Eval files are compiled with their `assert` statements rewritten (as pytest does) into a call
that records the outcome on the attempt, then raises `AssertionError` as `assert` would.
"""

from __future__ import annotations

import ast
import itertools
import linecache
import traceback
from collections.abc import Callable
from contextvars import ContextVar
from typing import Any

Recorder = Callable[[dict[str, Any]], None]

_recorder: ContextVar[Recorder | None] = ContextVar("_recorder", default=None)

ASSERT_HOOK = "__reeval_assert__"

_OPS: dict[type[ast.cmpop], str] = {
    ast.Eq: "==",
    ast.NotEq: "!=",
    ast.Lt: "<",
    ast.LtE: "<=",
    ast.Gt: ">",
    ast.GtE: ">=",
    ast.Is: "is",
    ast.IsNot: "is not",
    ast.In: "in",
    ast.NotIn: "not in",
}


class RecordedAssertionError(AssertionError):
    """An `assert` that failed and is already in the attempt record."""


def bind_recorder(recorder: Recorder) -> None:
    _recorder.set(recorder)


def _shown(value: Any) -> str:
    try:
        text = repr(value)
    except Exception:  # noqa: BLE001
        text = f"<{type(value).__name__}>"
    return text if len(text) <= 200 else f"{text[:200]}…"


def check(
    value: Any,
    subject: str,
    label: str | None,
    message: Callable[[], Any] | None,
    compared: tuple[Any, str, Any] | None,
) -> None:
    """What a rewritten `assert` calls: records its outcome, and raises when it failed."""
    passed = bool(value)
    call: dict[str, Any] = {"op": "record", "matcher": "assert", "subject": subject}
    if label is not None:
        call["label"] = label
    reason = ""
    if not passed:
        if compared is not None:
            left, op, right = compared
            detail = f"assert {_shown(left)} {op} {_shown(right)}"
        elif isinstance(value, bool):
            detail = f"assert {subject}"
        else:
            detail = f"assert {subject} ({_shown(value)} is falsy)"
        extra = message() if message is not None else None
        prefix = label if label is not None else (str(extra) if extra is not None else None)
        reason = f"{prefix}: {detail}" if prefix else detail
        call["message"] = reason
    call["status"] = "pass" if passed else "fail"
    recorder = _recorder.get()
    if recorder is not None:
        recorder(call)
    if not passed:
        raise RecordedAssertionError(reason) if recorder is not None else AssertionError(reason)


def unrecorded_failure(exc: AssertionError) -> dict[str, Any]:
    """The `record` call for an `AssertionError` raised outside an eval file's own asserts."""
    frames = traceback.extract_tb(exc.__traceback__)
    line = ""
    if frames:
        last = frames[-1]
        line = (last.line or linecache.getline(last.filename, last.lineno or 0)).strip()
    subject = line.removeprefix("assert ").split(",")[0].strip() or "AssertionError"
    return {
        "op": "record",
        "matcher": "assert",
        "subject": subject,
        "status": "fail",
        "message": str(exc) or f"assert {subject}",
    }


class _Rewrite(ast.NodeTransformer):
    def __init__(self, source: str) -> None:
        self._source = source
        self._names = itertools.count(1)

    def visit_Assert(self, node: ast.Assert) -> list[ast.stmt]:
        self.generic_visit(node)
        subject = ast.get_source_segment(self._source, node.test) or ast.unparse(node.test)
        label: ast.expr = ast.Constant(None)
        message: ast.expr = ast.Constant(None)
        if isinstance(node.msg, ast.Constant) and isinstance(node.msg.value, str):
            label = node.msg
        elif node.msg is not None:
            message = ast.Lambda(
                args=ast.arguments(
                    posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]
                ),
                body=node.msg,
            )
        before: list[ast.stmt] = []
        value = node.test
        compared: ast.expr = ast.Constant(None)
        test = node.test
        if isinstance(test, ast.Compare) and len(test.ops) == 1 and type(test.ops[0]) in _OPS:
            n = next(self._names)
            left, right = f"@reeval_left{n}", f"@reeval_right{n}"
            before = [
                ast.Assign(targets=[ast.Name(left, ast.Store())], value=test.left),
                ast.Assign(targets=[ast.Name(right, ast.Store())], value=test.comparators[0]),
            ]
            value = ast.Compare(
                left=ast.Name(left, ast.Load()),
                ops=test.ops,
                comparators=[ast.Name(right, ast.Load())],
            )
            compared = ast.Tuple(
                elts=[
                    ast.Name(left, ast.Load()),
                    ast.Constant(_OPS[type(test.ops[0])]),
                    ast.Name(right, ast.Load()),
                ],
                ctx=ast.Load(),
            )
        call = ast.Expr(
            ast.Call(
                func=ast.Name(ASSERT_HOOK, ast.Load()),
                args=[value, ast.Constant(subject), label, message, compared],
                keywords=[],
            )
        )
        out = [*before, call]
        for stmt in out:
            ast.copy_location(stmt, node)
        return out


def compile_eval(source: str, filename: str) -> Any:
    """Compiles an eval file with its asserts recorded."""
    tree = _Rewrite(source).visit(ast.parse(source, filename))
    return compile(ast.fix_missing_locations(tree), filename, "exec")
