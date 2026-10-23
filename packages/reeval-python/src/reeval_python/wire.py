"""Map public Python values to attempt-protocol wire shapes (internal)."""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any, cast

from reeval_python.types import ExecResult, Turn, Verdict

# Python snake_case matcher method -> wire matcher name (Vitest + reeval table).
MATCHER_TO_WIRE: dict[str, str] = {
    "to_succeed": "toSucceed",
    "to_pass": "toPass",
    "to_equal": "toEqual",
    "to_contain": "toContain",
    "to_be_truthy": "toBeTruthy",
    "to_be": "toBe",
    "to_be_null": "toBeNull",
    "to_have_file": "toHaveFile",
    "to_have_edited": "toHaveEdited",
    "to_have_run": "toHaveRun",
    "to_have_searched": "toHaveSearched",
    "to_have_fetched": "toHaveFetched",
    "to_have_called_skill": "toHaveCalledSkill",
    "to_have_called_mcp": "toHaveCalledMcp",
    "to_have_called_tool": "toHaveCalledTool",
    "to_have_changed": "toHaveChanged",
}

# Judge / evaluate options: snake_case kwargs -> camelCase keys on the wire.
OPTION_KEY_TO_WIRE: dict[str, str] = {
    "max_retries": "maxRetries",
    "max_tokens": "maxTokens",
    "read_only": "readOnly",
}


def options_to_wire(options: dict[str, Any] | None) -> dict[str, Any] | None:
    if not options:
        return None
    out: dict[str, Any] = {}
    for key, value in options.items():
        wire_key = OPTION_KEY_TO_WIRE.get(key, key)
        out[wire_key] = value
    return out


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


def subject_for_matcher(actual: Any, matcher: str) -> dict[str, Any]:
    if isinstance(actual, ExecResult):
        result = {"exitCode": actual.exit_code, "stdout": actual.stdout, "stderr": actual.stderr}
        return {"exec": actual.command, "result": result}
    if isinstance(actual, Verdict):
        return {"value": actual.raw}
    if isinstance(actual, Turn):
        return {"turn": actual.index}
    if isinstance(actual, dict):
        wire_keys = ("exec", "turn", "attempt", "readFile", "value")
        if any(k in actual for k in wire_keys):
            return cast(dict[str, Any], actual)
    return {"value": actual}
