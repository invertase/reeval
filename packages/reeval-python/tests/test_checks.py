"""Eval files' asserts, rewritten: what each records, and what it raises."""

from __future__ import annotations

import contextvars
import linecache
from typing import Any

import pytest

from reeval_python.checks import (
    ASSERT_HOOK,
    RecordedAssertionError,
    bind_recorder,
    check,
    compile_eval,
    unrecorded_failure,
)

SOURCE = """
def body(items, name, flag):
    assert flag, "flag is set"
    assert len(items) == 2
    assert name in items, f"{name} is missing"
    assert items
"""


def _run(*args: Any) -> tuple[list[dict[str, Any]], BaseException | None]:
    """Runs SOURCE's body in an attempt, returning its record calls and what it raised."""
    calls: list[dict[str, Any]] = []
    scope: dict[str, Any] = {ASSERT_HOOK: check}
    exec(compile_eval(SOURCE, "sample.eval.py"), scope)  # noqa: S102

    def attempt() -> BaseException | None:
        bind_recorder(calls.append)
        try:
            scope["body"](*args)
        except BaseException as exc:  # noqa: BLE001
            return exc
        return None

    raised = contextvars.copy_context().run(attempt)
    return calls, raised


def test_passing_asserts_record_their_label_or_what_they_checked() -> None:
    calls, raised = _run(["a", "b"], "a", True)
    assert raised is None
    assert calls == [
        {
            "op": "record",
            "matcher": "assert",
            "subject": "flag",
            "label": "flag is set",
            "status": "pass",
        },
        {"op": "record", "matcher": "assert", "subject": "len(items) == 2", "status": "pass"},
        {"op": "record", "matcher": "assert", "subject": "name in items", "status": "pass"},
        {"op": "record", "matcher": "assert", "subject": "items", "status": "pass"},
    ]


def test_a_failed_compare_shows_both_sides_and_its_message() -> None:
    calls, raised = _run(["a", "b"], "z", True)
    assert isinstance(raised, RecordedAssertionError)
    assert str(raised) == "z is missing: assert 'z' in ['a', 'b']"
    assert calls[-1] == {
        "op": "record",
        "matcher": "assert",
        "subject": "name in items",
        "status": "fail",
        "message": "z is missing: assert 'z' in ['a', 'b']",
    }


def test_a_falsy_value_is_shown_and_a_label_leads_the_message() -> None:
    calls, raised = _run([], "a", 0)
    assert str(raised) == "flag is set: assert flag (0 is falsy)"
    assert calls[-1]["label"] == "flag is set"
    _, raised = _run(["a"], "a", True)
    assert str(raised) == "assert 1 == 2"


def test_outside_an_attempt_assert_raises_as_python_does() -> None:
    scope: dict[str, Any] = {ASSERT_HOOK: check}
    with pytest.raises(AssertionError, match=r"^assert 1 == 2$") as raised:
        exec(compile_eval("assert 1 == 2\n", "top.eval.py"), scope)  # noqa: S102
    assert not isinstance(raised.value, RecordedAssertionError)


def test_an_assert_outside_an_eval_file_is_recorded_by_its_line() -> None:
    source = 'def helper(ok):\n    assert ok, "helper says no"\n'
    linecache.cache["helper.py"] = (len(source), None, source.splitlines(True), "helper.py")
    scope: dict[str, Any] = {}
    exec(compile(source, "helper.py", "exec"), scope)  # noqa: S102
    with pytest.raises(AssertionError) as raised:
        scope["helper"](False)
    assert unrecorded_failure(raised.value) == {
        "op": "record",
        "matcher": "assert",
        "subject": "ok",
        "status": "fail",
        "message": "helper says no",
    }
