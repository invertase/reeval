"""Map public Python values to attempt-protocol wire shapes (internal)."""

from __future__ import annotations

import inspect
import json
import math
import re
from collections.abc import Iterable
from datetime import timedelta
from typing import Any, cast

from reeval_python._wire import CAMEL_KEYS, DURATION_FIELDS, RECORD_FIELDS, MatcherSubject
from reeval_python.types import ExecResult, Turn, Verdict

_SNAKE = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)+")


def _camel(key: str) -> str:
    """reeval's spelling of one of its keys written in snake_case (`min_lift` -> `minLift`)."""
    if not _SNAKE.fullmatch(key):
        return key
    head, *rest = key.split("_")
    camel = head + "".join(part.capitalize() for part in rest)
    return camel if camel in CAMEL_KEYS else key


def seconds(value: object, where: str) -> float:
    """A duration the eval wrote, as seconds: a `timedelta`, or a number of seconds."""
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    raise TypeError(
        f"{where} takes seconds or a timedelta, e.g. 90 or timedelta(minutes=5) (got {value!r})"
    )


def _number(n: float) -> str:
    return str(int(n)) if n == int(n) else f"{n:.3f}".rstrip("0")


def duration_to_wire(value: Any, where: str) -> str:
    """A duration as reeval writes one: `"90s"`, `"5m"`, `"1h"` or `"250ms"`."""
    ms = round(seconds(value, where) * 1000, 3)
    for unit, size in (("h", 3_600_000), ("m", 60_000), ("s", 1000)):
        if ms and ms % size == 0:
            return f"{_number(ms / size)}{unit}"
    return f"{_number(ms)}ms"


def value_to_wire(value: Any, *, record: bool = False) -> Any:
    """Options as reeval's data: the SDK's objects (environments, sandboxes) as plain data,
    durations from seconds, and reeval's own keys at any depth in camelCase. A record's keys
    (`env`, `headers`, …) are the eval's own and keep their spelling; reeval names any other key
    it doesn't have."""
    to_wire = getattr(value, "_to_wire", None)
    if callable(to_wire):
        return to_wire()
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in cast(dict[str, Any], value).items():
            if record or not isinstance(cast(object, key), str):
                out[key] = value_to_wire(item, record=key in RECORD_FIELDS)
                continue
            name = _camel(key)
            if name in DURATION_FIELDS:
                out[name] = duration_to_wire(item, key)
            else:
                out[name] = value_to_wire(item, record=name in RECORD_FIELDS)
        return out
    if isinstance(value, list | tuple):
        return [value_to_wire(v) for v in cast(list[Any], value)]
    return value


def options_to_wire(options: dict[str, Any] | None) -> dict[str, Any] | None:
    """Eval, group or judge options as reeval's data."""
    if not options:
        return None
    return cast(dict[str, Any], value_to_wire(options))


def json_value(value: Any, where: str) -> Any:
    """A value reeval reads as JSON: an `ExecResult` or a `Verdict` as their data, and anything
    else that isn't JSON refused here, where the eval passed it."""
    if isinstance(value, ExecResult):
        return {"exitCode": value.exit_code, "stdout": value.stdout, "stderr": value.stderr}
    if isinstance(value, Verdict):
        return value._data  # pyright: ignore[reportPrivateUsage]
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"{where}: {exc}") from None
    return value


class Patterns:
    """The `re` patterns in one call's arguments, by the `matchedBy` each goes on the wire as.

    reeval never compiles them: it asks for the strings a matcher tested them on, and each is
    answered here with `pattern.search`.
    """

    def __init__(self) -> None:
        self._by_name: dict[str, tuple[re.Pattern[Any], list[dict[str, Any]]]] = {}

    def __bool__(self) -> bool:
        return bool(self._by_name)

    def wire(self, pattern: re.Pattern[Any]) -> dict[str, Any]:
        name = repr(pattern)
        n = 1
        # repr cuts a long pattern short, so two patterns can share one.
        while name in self._by_name and not _same(self._by_name[name][0], pattern):
            n += 1
            name = f"{repr(pattern)} #{n}"
        arg: dict[str, Any] = {"matchedBy": name, "answers": {}}
        self._by_name.setdefault(name, (pattern, []))[1].append(arg)
        return arg

    def answer(self, untested: dict[str, list[str]]) -> None:
        for name, strings in untested.items():
            if name not in self._by_name:
                raise RuntimeError(f"reeval asked about {name}, which this call didn't send")
            pattern, args = self._by_name[name]
            answers = {s: _search(pattern, s) for s in strings}
            for arg in args:
                arg["answers"].update(answers)


def _same(a: re.Pattern[Any], b: re.Pattern[Any]) -> bool:
    return a.pattern == b.pattern and a.flags == b.flags


def _search(pattern: re.Pattern[Any], text: str) -> bool:
    if isinstance(pattern.pattern, bytes):
        return pattern.search(text.encode()) is not None
    return pattern.search(text) is not None


def wire_args(args: Iterable[Any], patterns: Patterns) -> list[Any]:
    """The arguments as JSON, with every `re.Pattern` in them, at any depth, one of `patterns`."""

    def value(v: Any) -> Any:
        if isinstance(v, re.Pattern):
            return patterns.wire(cast(re.Pattern[Any], v))
        if isinstance(v, dict):
            return {k: value(x) for k, x in cast(dict[Any, Any], v).items()}
        if isinstance(v, list | tuple):
            return [value(x) for x in cast(Iterable[Any], v)]
        return v

    return [value(a) for a in args]


def subject_for_matcher(actual: Any) -> MatcherSubject:
    """What `expect` checks: reeval reads the attempt, a turn, a command or a file itself."""
    from reeval_python.context import AttemptContext, SyncAttemptContext

    if isinstance(actual, AttemptContext | SyncAttemptContext):
        return {"attempt": True}
    if inspect.iscoroutine(actual):
        actual.close()
        raise TypeError(
            "expect() takes a result, not a coroutine: await it first, as in "
            "expect(await c.exec(…)), or poll it with expect.poll(lambda: c.read_file(…))"
        )
    if isinstance(actual, ExecResult):
        result = {"exitCode": actual.exit_code, "stdout": actual.stdout, "stderr": actual.stderr}
        return cast(MatcherSubject, {"exec": actual.command, "result": result})
    if isinstance(actual, Turn):
        return {"turn": actual.index}
    accepted = "expect() takes the attempt, a turn, c.exec(…), c.read_file(…) or a JSON value"
    return {"value": json_value(actual, accepted)}
