"""Turn plain Python assert failures into attempt-protocol expect calls."""

from __future__ import annotations

import ast
import linecache
from dataclasses import dataclass
from types import FrameType
from typing import Any


@dataclass(frozen=True, slots=True)
class AssertExpect:
    subject: dict[str, Any]
    matcher: str
    args: list[Any]
    label: str | None
    not_: bool = False


@dataclass(frozen=True, slots=True)
class _EvalFrame:
    filename: str
    lineno: int
    frame: FrameType


def _safe_eval(node: ast.expr, frame: FrameType) -> Any:
    code = compile(ast.Expression(node), "<assert>", "eval")
    return eval(code, frame.f_globals, frame.f_locals)  # noqa: S307


def _show(value: Any) -> str:
    try:
        return repr(value)
    except Exception:  # noqa: BLE001
        return "<unrepr>"


def _frame_for_assert(exc: BaseException) -> _EvalFrame | None:
    tb = exc.__traceback__
    found: _EvalFrame | None = None
    while tb is not None:
        if tb.tb_frame.f_code.co_filename.endswith(".eval.py"):
            found = _EvalFrame(tb.tb_frame.f_code.co_filename, tb.tb_lineno, tb.tb_frame)
        tb = tb.tb_next
    return found


def _parse_assert_line(source: str, lineno: int, filename: str) -> ast.Assert | None:
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError:
        tree = None
    if tree is not None:
        for node in ast.walk(tree):
            if isinstance(node, ast.Assert) and node.lineno == lineno:
                return node
    line = linecache.getline(filename, lineno).strip()
    if not line.startswith("assert"):
        return None
    try:
        parsed = ast.parse(line)
    except SyntaxError:
        return None
    stmt = parsed.body[0] if parsed.body else None
    return stmt if isinstance(stmt, ast.Assert) else None


def _label_from_assert(node: ast.Assert, exc: AssertionError) -> str | None:
    if node.msg is not None:
        try:
            if isinstance(node.msg, ast.Constant) and isinstance(node.msg.value, str):
                return node.msg.value
        except Exception:  # noqa: BLE001
            pass
    if exc.args and isinstance(exc.args[0], str):
        return exc.args[0]
    return None


def _wire_for_test(test: ast.expr, frame: FrameType, label: str | None) -> AssertExpect:
    if isinstance(test, ast.Compare) and len(test.ops) == 1 and len(test.comparators) == 1:
        op = test.ops[0]
        left = _safe_eval(test.left, frame)
        right = _safe_eval(test.comparators[0], frame)
        if isinstance(op, ast.Eq):
            enriched = label or f"assert {_show(left)} == {_show(right)}"
            return AssertExpect(
                subject={"value": left},
                matcher="toEqual",
                args=[right],
                label=enriched,
            )
        if isinstance(op, ast.Is):
            enriched = label or f"assert {_show(left)} is {_show(right)}"
            return AssertExpect(
                subject={"value": left},
                matcher="toBe",
                args=[right],
                label=enriched,
            )
        if isinstance(op, ast.IsNot):
            enriched = label or f"assert {_show(left)} is not {_show(right)}"
            return AssertExpect(
                subject={"value": left},
                matcher="toBe",
                args=[right],
                label=enriched,
                not_=True,
            )

    if isinstance(test, ast.Constant) and test.value is False:
        return AssertExpect(
            subject={"value": False},
            matcher="toBeTruthy",
            args=[],
            label=label or "assert False",
        )

    actual = _safe_eval(test, frame)
    enriched = label
    if enriched is None:
        enriched = f"assert {_show(actual)}"
    elif not actual:
        enriched = f"{enriched} ({_show(actual)} is falsy)"
    return AssertExpect(
        subject={"value": actual},
        matcher="toBeTruthy",
        args=[],
        label=enriched,
    )


def assert_to_expect(exc: AssertionError) -> AssertExpect:
    frame = _frame_for_assert(exc)
    if frame is None:
        msg = str(exc) if str(exc) else "assertion failed"
        return AssertExpect(
            subject={"value": False},
            matcher="toBeTruthy",
            args=[],
            label=msg,
        )

    source = linecache.getlines(frame.filename)
    if not source:
        msg = str(exc) if str(exc) else "assertion failed"
        return AssertExpect(
            subject={"value": False},
            matcher="toBeTruthy",
            args=[],
            label=msg,
        )

    block = "".join(source)
    node = _parse_assert_line(block, frame.lineno, frame.filename)
    if node is None:
        msg = str(exc) if str(exc) else "assertion failed"
        return AssertExpect(
            subject={"value": False},
            matcher="toBeTruthy",
            args=[],
            label=msg,
        )

    label = _label_from_assert(node, exc)
    return _wire_for_test(node.test, frame.frame, label)
