"""Plain `assert` in an eval file: each one, passing or failing, is a check in the attempt record.

Eval files are compiled with their `assert` statements rewritten (as pytest does): the test and,
when it fails, the message are evaluated in the eval's own frame, and the eval's frame raises the
`AssertionError` a call returns, as `assert` would. A check is named by the assert's test, as
written. A pass is recorded at once; a failure travels on its `AssertionError` and is recorded
only if that escapes the body, so a failure the body catches isn't a failed check.
"""

from __future__ import annotations

import ast
import itertools
import linecache
import traceback
import warnings
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


_CHECK = "_reeval_check"

SUBJECT_LIMIT = 200


def bind_recorder(recorder: Recorder) -> None:
    _recorder.set(recorder)


def failed_check(exc: BaseException) -> dict[str, Any] | None:
    """The `record` call an eval file's failed `assert` raised `exc` with."""
    return getattr(exc, _CHECK, None)


def _shown(value: Any) -> str:
    try:
        text = repr(value)
    except Exception:  # noqa: BLE001
        text = f"<{type(value).__name__}>"
    return text if len(text) <= 200 else f"{text[:200]}…"


def _subject(source: str) -> str:
    """A check's subject on one line, short enough to be its name."""
    text = " ".join(source.split())
    return text if len(text) <= SUBJECT_LIMIT else f"{text[: SUBJECT_LIMIT - 1]}…"


def check(
    value: Any,
    subject: str,
    message: tuple[Any] | BaseException | None,
    compared: tuple[Any, str, Any] | None,
) -> AssertionError | None:
    """What a rewritten `assert` calls: records a pass, and returns the error to raise.

    `message` is the assert's message in a 1-tuple, the exception evaluating it raised (which
    the eval's frame raises instead), or `None`.
    """
    call: dict[str, Any] = {"op": "record", "matcher": "assert", "subject": subject}
    if value:
        call["status"] = "pass"
        recorder = _recorder.get()
        if recorder is not None:
            recorder(call)
        return None
    if compared is not None:
        left, op, right = compared
        detail = f"assert {_shown(left)} {op} {_shown(right)}"
    elif isinstance(value, bool):
        detail = f"assert {subject}"
    else:
        detail = f"assert {subject} ({_shown(value)} is falsy)"
    if isinstance(message, BaseException):
        extra: Any = f"<the message raised {type(message).__name__}: {message}>"
    else:
        extra = message[0] if message is not None else None
    reason = f"{extra}: {detail}" if extra is not None else detail
    error = AssertionError(reason)
    failed = {**call, "status": "fail", "message": reason}
    setattr(error, _CHECK, failed)
    if isinstance(message, BaseException):
        setattr(message, _CHECK, failed)
    return error


def _assert_at(filename: str, lineno: int) -> ast.Assert | None:
    """The innermost `assert` statement in a file that spans a line, if there is one."""
    source = "".join(linecache.getlines(filename))
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return None
    found: ast.Assert | None = None
    for node in ast.walk(tree):
        end = node.end_lineno if isinstance(node, ast.Assert) else None
        if isinstance(node, ast.Assert) and end is not None and node.lineno <= lineno <= end:
            if found is None or node.lineno >= found.lineno:
                found = node
    return found


def unrecorded_failure(exc: AssertionError) -> dict[str, Any]:
    """The `record` call for an `AssertionError` raised outside an eval file's own asserts.

    Its subject is the failing `assert`'s test when an `assert` statement raised it, and
    `AssertionError` otherwise (`raise AssertionError`, unittest's `assertEqual`).
    """
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename != __file__]
    subject = "AssertionError"
    if frames and frames[-1].lineno is not None:
        node = _assert_at(frames[-1].filename, frames[-1].lineno)
        source = "".join(linecache.getlines(frames[-1].filename))
        if node is not None:
            subject = _subject(ast.get_source_segment(source, node.test) or ast.unparse(node.test))
    message = str(exc) or (f"assert {subject}" if subject != "AssertionError" else subject)
    return {
        "op": "record",
        "matcher": "assert",
        "subject": subject,
        "status": "fail",
        "message": message,
    }


def _name(name: str, ctx: ast.expr_context | None = None) -> ast.Name:
    return ast.Name(name, ctx or ast.Load())


class _Rewrite(ast.NodeTransformer):
    def __init__(self, source: str, filename: str) -> None:
        self._source = source
        self._filename = filename
        self._names = itertools.count(1)

    def visit_Assert(self, node: ast.Assert) -> list[ast.stmt]:
        self.generic_visit(node)
        if isinstance(node.test, ast.Tuple) and node.test.elts:
            warnings.warn_explicit(
                "assertion is always true, perhaps remove parentheses?",
                SyntaxWarning,
                self._filename,
                node.lineno,
            )
        n = next(self._names)
        value, message, error, raised = (f"@reeval_{x}{n}" for x in ("value", "msg", "err", "exc"))
        temps = [value, message, error]
        subject = _subject(
            ast.get_source_segment(self._source, node.test) or ast.unparse(node.test)
        )
        test = node.test
        compared: ast.expr = ast.Constant(None)
        before: list[ast.stmt] = []
        if isinstance(test, ast.Compare) and len(test.ops) == 1 and type(test.ops[0]) in _OPS:
            left, right = f"@reeval_left{n}", f"@reeval_right{n}"
            temps += [left, right]
            before = [
                ast.Assign(targets=[_name(left, ast.Store())], value=test.left),
                ast.Assign(targets=[_name(right, ast.Store())], value=test.comparators[0]),
            ]
            test = ast.Compare(left=_name(left), ops=test.ops, comparators=[_name(right)])
            op = ast.Constant(_OPS[type(node.test.ops[0])])  # type: ignore[union-attr]
            compared = ast.Tuple(elts=[_name(left), op, _name(right)], ctx=ast.Load())
        before.append(ast.Assign(targets=[_name(value, ast.Store())], value=test))
        before.append(ast.Assign(targets=[_name(message, ast.Store())], value=ast.Constant(None)))

        def hook(msg: ast.expr) -> ast.Call:
            args = [_name(value), ast.Constant(subject), msg, compared]
            return ast.Call(func=_name(ASSERT_HOOK), args=args, keywords=[])

        if node.msg is not None:
            # Evaluated here, in the eval's frame, and only when the test failed, as Python
            # does: `await`, `yield` and class-scope names work in it.
            boxed = ast.Tuple(elts=[node.msg], ctx=ast.Load())
            evaluate = ast.Try(
                body=[ast.Assign(targets=[_name(message, ast.Store())], value=boxed)],
                handlers=[
                    ast.ExceptHandler(
                        type=_name("BaseException"),
                        name=raised,
                        body=[ast.Expr(hook(_name(raised))), ast.Raise()],
                    )
                ],
                orelse=[],
                finalbody=[],
            )
            before.append(
                ast.If(test=ast.UnaryOp(ast.Not(), _name(value)), body=[evaluate], orelse=[])
            )
        out: list[ast.stmt] = [
            *before,
            ast.Assign(targets=[_name(error, ast.Store())], value=hook(_name(message))),
            ast.If(
                test=ast.Compare(_name(error), [ast.IsNot()], [ast.Constant(None)]),
                body=[ast.Raise(exc=_name(error))],
                orelse=[],
            ),
            ast.Delete(targets=[_name(t, ast.Del()) for t in temps]),
        ]
        for stmt in out:
            ast.copy_location(stmt, node)
        return out


def compile_eval(source: str, filename: str) -> Any:
    """Compiles an eval file with its asserts recorded."""
    tree = _Rewrite(source, filename).visit(ast.parse(source, filename))
    return compile(ast.fix_missing_locations(tree), filename, "exec", dont_inherit=True)
