"""Map public Python values to attempt-protocol wire shapes (internal)."""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any, cast

from reeval_python._wire import MatcherSubject
from reeval_python.types import ExecResult, Turn, Verdict


def matcher_to_wire(name: str) -> str:
    """A matcher method's name as reeval's (`to_have_edited` -> `toHaveEdited`); reeval refuses
    a matcher it doesn't have."""
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


_SNAKE = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)+")


def camel_keys(options: dict[str, Any]) -> dict[str, Any]:
    """An options dict's own snake_case keys (`min_lift`) as reeval's (`minLift`).

    One level only: nested dicts such as `env` hold the user's own keys.
    """
    out: dict[str, Any] = {}
    for key, value in options.items():
        if _SNAKE.fullmatch(key):
            head, *rest = key.split("_")
            key = head + "".join(part.capitalize() for part in rest)
        out[key] = value
    return out


def value_to_wire(value: Any) -> Any:
    """A value with the SDK's objects in it (environments) as plain data."""
    to_wire = getattr(value, "to_wire", None)
    if callable(to_wire):
        return to_wire()
    if isinstance(value, dict):
        return {k: value_to_wire(v) for k, v in cast(dict[str, Any], value).items()}
    if isinstance(value, list | tuple):
        return [value_to_wire(v) for v in cast(list[Any], value)]
    return value


def options_to_wire(options: dict[str, Any] | None) -> dict[str, Any] | None:
    """Eval, group or judge options as reeval's data."""
    if not options:
        return None
    out = camel_keys(options)
    compare = out.get("compare")
    if isinstance(compare, dict):
        out["compare"] = camel_keys(cast(dict[str, Any], compare))
    return cast(dict[str, Any], value_to_wire(out))


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
    from reeval_python.context import AttemptContext, PendingExec, PendingRead, SyncAttemptContext

    if isinstance(actual, AttemptContext | SyncAttemptContext):
        return {"attempt": True}
    if isinstance(actual, PendingExec):
        return {"exec": actual.command}
    if isinstance(actual, PendingRead):
        return {"readFile": actual.path}
    if isinstance(actual, ExecResult):
        result = {"exitCode": actual.exit_code, "stdout": actual.stdout, "stderr": actual.stderr}
        return cast(MatcherSubject, {"exec": actual.command, "result": result})
    if isinstance(actual, Turn):
        return {"turn": actual.index}
    if isinstance(actual, Verdict):
        return cast(MatcherSubject, {"value": actual.raw})
    return {"value": actual}
