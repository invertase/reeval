"""Map public Python values to attempt-protocol wire shapes (internal)."""

from __future__ import annotations

import re
from typing import Any, cast

from reeval_python.types import ExecResult, Turn, Verdict

# Python snake_case matcher method -> wire matcher name (Vitest + reeval table).
MATCHER_TO_WIRE: dict[str, str] = {
    "to_succeed": "toSucceed",
    "to_pass": "toPass",
    "to_equal": "toEqual",
    "to_contain": "toContain",
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


def _pattern_arg(value: re.Pattern[str]) -> Any:
    return {"regexp": value.pattern, "flags": value.flags and int(value.flags) or None}


def wire_args(args: tuple[Any, ...]) -> list[Any]:
    out: list[Any] = []
    for a in args:
        if isinstance(a, re.Pattern):
            out.append(_pattern_arg(cast(re.Pattern[str], a)))
        else:
            out.append(a)
    return out


def subject_for_matcher(actual: Any, matcher: str) -> dict[str, Any]:
    if isinstance(actual, ExecResult) and matcher == "toSucceed":
        return {"exec": actual.command}
    if isinstance(actual, ExecResult):
        return {
            "value": {
                "exitCode": actual.exit_code,
                "stdout": actual.stdout,
                "stderr": actual.stderr,
            }
        }
    if isinstance(actual, Verdict):
        return {"value": actual.raw}
    if isinstance(actual, Turn):
        return {"turn": actual.index}
    if isinstance(actual, dict):
        wire_keys = ("exec", "turn", "attempt", "readFile", "value")
        if any(k in actual for k in wire_keys):
            return cast(dict[str, Any], actual)
    return {"value": actual}
