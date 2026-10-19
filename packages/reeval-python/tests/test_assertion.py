"""assert_to_expect parses eval assert statements."""

from __future__ import annotations

import linecache

from reeval_python.assertion import assert_to_expect


def _seed_linecache(filename: str, source: str) -> None:
    lines = source.splitlines(keepends=True)
    linecache.cache[filename] = (len(source), None, lines, filename)


def test_compare_eq_maps_to_to_equal() -> None:
    path = "sample.eval.py"
    source = "def body():\n    one = 1\n    assert one == 2, 'one is two'\nbody()\n"
    _seed_linecache(path, source)
    code = compile(source, path, "exec")
    try:
        exec(code, {})  # noqa: S102
    except AssertionError as exc:
        wire = assert_to_expect(exc)
        assert wire.matcher == "toEqual"
        assert wire.subject == {"value": 1}
        assert wire.args == [2]
        assert wire.label == "one is two"
        return
    raise AssertionError("expected assert to fail")


def test_truthy_assert() -> None:
    path = "truthy.eval.py"
    source = "def body():\n    flag = False\n    assert flag\nbody()\n"
    _seed_linecache(path, source)
    code = compile(source, path, "exec")
    try:
        exec(code, {})  # noqa: S102
    except AssertionError as exc:
        wire = assert_to_expect(exc)
        assert wire.matcher == "toBeTruthy"
        assert wire.subject == {"value": False}
        return
    raise AssertionError("expected assert to fail")
