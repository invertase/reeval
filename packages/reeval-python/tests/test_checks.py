"""Eval files' asserts, rewritten: what each records, and what it raises."""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import linecache
import traceback
import unittest
import warnings
from typing import Any

import pytest

from reeval_python.checks import (
    ASSERT_HOOK,
    bind_recorder,
    check,
    compile_eval,
    failed_check,
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


def test_passing_asserts_record_at_once_named_by_their_test() -> None:
    calls, raised = _run(["a", "b"], "a", True)
    assert raised is None
    assert calls == [
        {"op": "record", "matcher": "assert", "subject": "flag", "status": "pass"},
        {"op": "record", "matcher": "assert", "subject": "len(items) == 2", "status": "pass"},
        {"op": "record", "matcher": "assert", "subject": "name in items", "status": "pass"},
        {"op": "record", "matcher": "assert", "subject": "items", "status": "pass"},
    ]


def test_a_failed_compare_shows_both_sides_and_its_message() -> None:
    calls, raised = _run(["a", "b"], "z", True)
    assert isinstance(raised, AssertionError)
    assert str(raised) == "z is missing: assert 'z' in ['a', 'b']"
    assert [c["status"] for c in calls] == ["pass", "pass"], "a failure isn't recorded yet"
    assert failed_check(raised) == {
        "op": "record",
        "matcher": "assert",
        "subject": "name in items",
        "status": "fail",
        "message": "z is missing: assert 'z' in ['a', 'b']",
    }


def test_a_falsy_value_is_shown_and_the_message_leads_the_reason() -> None:
    calls, raised = _run([], "a", 0)
    assert calls == []
    assert str(raised) == "flag is set: assert flag (0 is falsy)"
    check_ = failed_check(raised) or {}
    assert (check_["subject"], check_["message"]) == ("flag", str(raised))
    _, raised = _run(["a"], "a", True)
    assert str(raised) == "assert 1 == 2"


def test_outside_an_attempt_assert_raises_as_python_does() -> None:
    scope: dict[str, Any] = {ASSERT_HOOK: check}
    with pytest.raises(AssertionError, match=r"^assert 1 == 2$") as raised:
        exec(compile_eval("assert 1 == 2\n", "top.eval.py"), scope)  # noqa: S102
    assert failed_check(raised.value) == {
        "op": "record",
        "matcher": "assert",
        "subject": "1 == 2",
        "status": "fail",
        "message": "assert 1 == 2",
    }


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


def _body(source: str, *args: Any) -> tuple[list[dict[str, Any]], Any, dict[str, Any]]:
    """Runs `body` from an eval file's source in an attempt: its record calls, what it returned
    or raised, and the module's globals."""
    calls: list[dict[str, Any]] = []
    scope: dict[str, Any] = {ASSERT_HOOK: check, "__name__": "reeval_eval"}
    linecache.cache["x.eval.py"] = (len(source), None, source.splitlines(True), "x.eval.py")

    def attempt() -> Any:
        bind_recorder(calls.append)
        exec(compile_eval(source, "x.eval.py"), scope)  # noqa: S102
        try:
            out = scope["body"](*args)
            return asyncio.run(out) if inspect.iscoroutine(out) else out
        except BaseException as exc:  # noqa: BLE001
            return exc

    return calls, contextvars.copy_context().run(attempt), scope


def test_a_message_can_await_yield_and_see_its_class() -> None:
    awaits = "async def body():\n    async def why(): return 'no'\n    assert False, await why()\n"
    _, raised, _ = _body(awaits)
    assert str(raised) == "no: assert False"
    assert (failed_check(raised) or {})["message"] == "no: assert False"

    yields = "def body():\n    def gen():\n        assert True, (yield 1)\n    return gen\n"
    _, gen, _ = _body(yields)
    assert inspect.isgeneratorfunction(gen)

    in_class = (
        "def body():\n    class C:\n        why = 'class says no'\n        assert False, why\n"
    )
    _, raised, _ = _body(in_class)
    assert str(raised) == "class says no: assert False"


def test_a_message_is_evaluated_only_when_the_assert_fails() -> None:
    calls, raised, _ = _body("def body():\n    assert True, 1 / 0\n")
    assert raised is None and calls[-1]["status"] == "pass"


def test_a_message_that_raises_carries_the_failure() -> None:
    _, raised, _ = _body("def body():\n    assert False, 1 / 0\n")
    assert isinstance(raised, ZeroDivisionError)
    assert (failed_check(raised) or {})["message"] == (
        "<the message raised ZeroDivisionError: division by zero>: assert False"
    )


def test_eval_files_keep_real_annotations() -> None:
    _, fn, _ = _body("def body():\n    def f(x: int) -> None: ...\n    return f\n")
    assert fn.__annotations__ == {"x": int, "return": None}


def test_asserts_in_nested_functions_and_classes_are_recorded() -> None:
    source = (
        "def body():\n"
        "    def inner(v):\n"
        "        assert v == 1\n"
        "    inner(1)\n"
        "    class C:\n"
        "        assert 2 > 1\n"
    )
    calls, raised, _ = _body(source)
    assert raised is None
    assert [c["subject"] for c in calls] == ["v == 1", "2 > 1"]


def test_temporaries_are_gone_after_the_assert() -> None:
    source = "x = 1\nassert x == 1, 'x'\nclass C:\n    assert x == 1\ndef body(): return C\n"
    _, cls, scope = _body(source)
    assert not [k for k in scope if k.startswith("@reeval")]
    assert not [k for k in vars(cls) if k.startswith("@reeval")]


def test_walrus_on_a_compared_side_binds_as_python_does() -> None:
    _, out, _ = _body("def body():\n    assert (y := 3) == 3\n    return y\n")
    assert out == 3


def test_the_traceback_ends_at_the_assert_in_the_eval_file() -> None:
    _, raised, _ = _body("\n\ndef body():\n    assert 1 == 2\n")
    assert type(raised) is AssertionError
    last = traceback.extract_tb(raised.__traceback__)[-1]
    assert (last.filename, last.lineno) == ("x.eval.py", 4)


def test_an_error_in_a_message_reports_the_asserts_line() -> None:
    source = "\n\ndef body():\n    x = 1\n    assert x == 1, nope\n    assert x == 2, nope\n"
    _, raised, _ = _body(source)
    assert isinstance(raised, NameError)
    assert traceback.extract_tb(raised.__traceback__)[-1].lineno == 6


def test_a_subject_is_one_bounded_line() -> None:
    calls, _, _ = _body("def body(a, b):\n    assert (\n        a\n        and b\n    )\n", 1, 1)
    assert calls[0]["subject"] == "a and b"
    long = "[" + ", ".join(str(i) for i in range(500)) + "]"
    calls, _, _ = _body(f"def body():\n    assert {long}\n")
    assert len(calls[0]["subject"]) == 200 and calls[0]["subject"].endswith("…")


def test_an_assert_on_a_tuple_still_warns() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        compile_eval("def body(a):\n    assert (a, 'msg')\n", "x.eval.py")
    assert any("always true" in str(w.message) for w in caught)


def _raised(source: str, filename: str, *args: Any) -> AssertionError:
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    scope: dict[str, Any] = {}
    exec(compile(source, filename, "exec"), scope)  # noqa: S102
    with pytest.raises(AssertionError) as raised:
        scope["helper"](*args)
    return raised.value


def test_an_unrecorded_failure_is_named_by_its_whole_assert() -> None:
    error = _raised("def helper(f):\n    assert f(1, 2) == 4\n", "h1.py", lambda a, b: a + b)
    assert unrecorded_failure(error)["subject"] == "f(1, 2) == 4"
    multi = "def helper(a):\n    assert (\n        a\n        and a\n    ), 'no'\n"
    assert unrecorded_failure(_raised(multi, "h2.py", 0))["subject"] == "a and a"


def test_an_assertion_error_not_raised_by_an_assert_is_named_assertion_error() -> None:
    with pytest.raises(AssertionError) as raised:
        unittest.TestCase().assertEqual(1, 2)
    call = unrecorded_failure(raised.value)
    assert call["subject"] == "AssertionError"
    assert call["message"] == "1 != 2"


def test_a_threads_assert_raised_in_the_body_is_named_by_its_test() -> None:
    source = (
        "import threading\n"
        "def body():\n"
        "    err = []\n"
        "    def work():\n"
        "        try:\n"
        "            assert 1 == 2\n"
        "        except AssertionError as e:\n"
        "            err.append(e)\n"
        "    t = threading.Thread(target=work)\n"
        "    t.start()\n"
        "    t.join()\n"
        "    raise err[0]\n"
    )
    _, raised, _ = _body(source)
    assert unrecorded_failure(raised)["subject"] == "1 == 2"


def test_a_failure_the_body_catches_is_not_a_check() -> None:
    source = (
        "def body():\n"
        "    try:\n"
        "        assert 1 == 2, 'retried'\n"
        "    except AssertionError:\n"
        "        pass\n"
        "    assert 2 == 2\n"
    )
    calls, raised, _ = _body(source)
    assert raised is None
    assert calls == [
        {"op": "record", "matcher": "assert", "subject": "2 == 2", "status": "pass"},
    ]
