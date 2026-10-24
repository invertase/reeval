"""Typed results for attempt calls (public, not wire-shaped)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, cast


@dataclass(frozen=True, slots=True)
class ExecResult:
    command: str
    exit_code: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.exit_code == 0

    @classmethod
    def _from_wire(cls, command: str, data: dict[str, Any]) -> ExecResult:
        return cls(
            command=command,
            exit_code=int(data.get("exitCode", 1)),
            stdout=str(data.get("stdout") or ""),
            stderr=str(data.get("stderr") or ""),
        )


@dataclass(frozen=True, slots=True)
class BackgroundHandle:
    id: str

    @classmethod
    def _from_wire(cls, data: dict[str, Any]) -> BackgroundHandle:
        return cls(id=str(data.get("handle") or ""))


TurnStatus = Literal["completed", "aborted", "error"]


@dataclass(frozen=True, slots=True)
class FileChange:
    path: str
    status: Literal["added", "modified", "deleted"]


@dataclass(frozen=True, slots=True)
class Diff:
    """The workspace's changes since the eval started, as of the end of a turn."""

    files: tuple[FileChange, ...]
    patch: str


def _diff(data: Any) -> Diff | None:
    if not isinstance(data, dict):
        return None
    wire = cast(dict[str, Any], data)
    files = cast(list[dict[str, Any]], wire.get("files") or [])
    return Diff(
        files=tuple(FileChange(str(f.get("path")), f.get("status", "modified")) for f in files),
        patch=str(wire.get("patch") or ""),
    )


@dataclass(frozen=True, slots=True)
class Turn:
    """One `c.send(…)`: the prompt, the agent's final message and how the turn ended."""

    index: int
    prompt: str
    text: str
    status: TurnStatus
    model: str | None
    """The model the harness says served the turn, when it reports one."""
    diff: Diff | None

    @classmethod
    def _from_wire(cls, index: int, data: dict[str, Any]) -> Turn:
        model = data.get("model")
        return cls(
            index=index,
            prompt=str(data.get("prompt") or ""),
            text=str(data.get("text") or ""),
            status=cast(TurnStatus, data.get("status") or "error"),
            model=None if model is None else str(model),
            diff=_diff(data.get("diff")),
        )


VerdictKind = Literal["pass", "fail", "error"]


@dataclass(frozen=True, slots=True)
class Verdict:
    verdict: VerdictKind
    score: float
    threshold: float
    question: str
    model: str
    reason: str | None
    _data: dict[str, Any] = field(repr=False, compare=False)

    @property
    def passed(self) -> bool:
        return self.verdict == "pass"

    @classmethod
    def _from_wire(cls, data: dict[str, Any]) -> Verdict:
        reasons = (data.get(k) for k in ("reason", "explanation", "rationale"))
        reason = next((r for r in reasons if isinstance(r, str) and r), None)
        return cls(
            verdict=cast(VerdictKind, data.get("verdict", "fail")),
            score=float(data.get("score", 0)),
            threshold=float(data.get("threshold", 0)),
            question=str(data.get("question") or ""),
            model=str(data.get("model") or ""),
            reason=reason,
            _data=dict(data),
        )
