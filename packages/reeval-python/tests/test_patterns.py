"""`re` patterns in matcher arguments: reeval asks for strings, Python matches them with `re`."""

from __future__ import annotations

import asyncio
import re
import threading
from typing import Any

import pytest

from reeval_python.context import PATTERN_ROUNDS, AttemptContext
from reeval_python.errors import ReevalAssertionError
from reeval_python.wire import Patterns


class Host:
    """reeval's side of `expect`: tests each pattern on `strings`, asking for any unanswered."""

    def __init__(self, strings: list[str]) -> None:
        self.strings = strings
        self.calls: list[dict[str, Any]] = []

    async def send(self, call: Any) -> dict[str, Any]:
        self.calls.append(_copy(call))
        patterns = _patterns(call["args"])
        untested = {
            p["matchedBy"]: [s for s in self.strings if s not in p["answers"]]
            for p in patterns
            if any(s not in p["answers"] for s in self.strings)
        }
        if untested:
            return {"ok": True, "op": "expect", "untested": untested}
        matched = any(p["answers"][s] for p in patterns for s in self.strings)
        status = "pass" if matched != call["not"] else "fail"
        assertion = {"label": "l", "matcher": call["matcher"], "status": status, "soft": False}
        return {"ok": True, "op": "expect", "assertion": {**assertion, "message": "no match"}}


def _copy(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _copy(v) for k, v in value.items()}  # pyright: ignore[reportUnknownVariableType]
    if isinstance(value, list):
        return [_copy(v) for v in value]  # pyright: ignore[reportUnknownVariableType]
    return value


def _patterns(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict) and "matchedBy" in value:
        return [value]  # pyright: ignore[reportUnknownVariableType]
    if isinstance(value, dict):
        return [p for v in value.values() for p in _patterns(v)]  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]
    if isinstance(value, list):
        return [p for v in value for p in _patterns(v)]  # pyright: ignore[reportUnknownVariableType]
    return []


def _expect(host: Host, args: list[Any], *, not_: bool = False, poll: Any = None) -> None:
    c = AttemptContext("a", host.send)
    asyncio.run(
        c.run_expect(
            subject={"turn": 0},
            matcher="toHaveRun",
            args=args,
            label=None,
            not_=not_,
            soft=False,
            poll=poll,
        )
    )


def test_a_pattern_goes_as_its_repr_and_is_answered_with_re_search() -> None:
    host = Host(["npm test", "ls"])
    _expect(host, [re.compile(r"^npm t(est)?$", re.IGNORECASE)])
    name = "re.compile('^npm t(est)?$', re.IGNORECASE)"
    assert [call["args"] for call in host.calls] == [
        [{"matchedBy": name, "answers": {}}],
        [{"matchedBy": name, "answers": {"npm test": True, "ls": False}}],
    ]


def test_anything_re_accepts_is_matched_as_re_matches_it() -> None:
    lookbehind = re.compile(r"(?<=npm )test")
    _expect(Host(["npm test"]), [lookbehind])
    verbose = re.compile(r"npm \s+ test  # spaces are ignored", re.VERBOSE)
    _expect(Host(["npm \t test"]), [verbose])
    _expect(Host(["npm test"]), [re.compile(rb"npm\x20test")])
    with pytest.raises(ReevalAssertionError, match="no match"):
        _expect(Host(["npm test"]), [re.compile(r"(?<=npm )test")], not_=True)


def test_patterns_at_any_depth_are_answered_and_long_ones_kept_apart() -> None:
    long_a = re.compile("a" * 300 + "x")
    long_b = re.compile("a" * 300 + "y")
    assert repr(long_a) == repr(long_b)
    host = Host(["a" * 300 + "y"])
    _expect(host, [{"query": long_a}, [long_b]])
    last = host.calls[-1]["args"]
    assert last[0]["query"]["answers"] == {"a" * 300 + "y": False}
    assert last[1][0]["answers"] == {"a" * 300 + "y": True}
    assert last[1][0]["matchedBy"] == f"{long_b!r} #2"


class Changing(Host):
    """A subject with a new string on every read, so reeval always has one untested."""

    async def send(self, msg: dict[str, Any]) -> dict[str, Any]:
        self.strings = [f"line {len(self.calls)}"]
        return await super().send(msg)


def test_a_subject_that_changes_on_every_read_stops_after_a_few_rounds() -> None:
    host = Changing([])
    with pytest.raises(RuntimeError, match=r"subject changed while reeval matched re\.compile"):
        _expect(host, [re.compile("line")])
    assert len(host.calls) == 1 + PATTERN_ROUNDS


def test_patterns_are_answered_off_the_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    loop_ran = threading.Event()
    loops: list[asyncio.AbstractEventLoop] = []
    waited: list[bool] = []
    answer = Patterns.answer

    # Answering asks the loop to set loop_ran and waits for it: off the loop it's set straight
    # away; on the loop it can't be until the answer returns, however fast the host.
    def answer_once_the_loop_runs(self: Patterns, untested: dict[str, list[str]]) -> None:
        loops[0].call_soon_threadsafe(loop_ran.set)
        waited.append(loop_ran.wait(timeout=10))
        answer(self, untested)

    monkeypatch.setattr(Patterns, "answer", answer_once_the_loop_runs)

    async def main() -> None:
        loops.append(asyncio.get_running_loop())
        c = AttemptContext("a", Host(["ab", "cd"]).send)
        await c.run_expect(
            subject={"turn": 0},
            matcher="toHaveRun",
            args=[re.compile("a")],
            label=None,
            not_=True,
            soft=True,
        )

    asyncio.run(main())
    assert waited == [True], "the event loop stopped while the patterns were matched"
