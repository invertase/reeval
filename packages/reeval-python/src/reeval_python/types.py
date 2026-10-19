"""Typed results for attempt calls (public, not wire-shaped)."""

from __future__ import annotations

from dataclasses import dataclass
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
    def from_wire(cls, command: str, data: dict[str, Any]) -> ExecResult:
        return cls(
            command=command,
            exit_code=int(data.get("exitCode", data.get("exit_code", 1))),
            stdout=str(data.get("stdout") or ""),
            stderr=str(data.get("stderr") or ""),
        )


@dataclass(frozen=True, slots=True)
class BackgroundHandle:
    id: str

    @classmethod
    def from_wire(cls, data: dict[str, Any]) -> BackgroundHandle:
        return cls(id=str(data.get("handle") or data.get("id") or ""))


@dataclass(frozen=True, slots=True)
class Turn:
    index: int
    raw: dict[str, Any]

    @property
    def prompt(self) -> str:
        return str(self.raw.get("prompt") or "")

    @property
    def text(self) -> str:
        return str(self.raw.get("text") or "")

    @property
    def status(self) -> str:
        return str(self.raw.get("status") or "")

    @property
    def diff(self) -> dict[str, Any] | None:
        diff = self.raw.get("diff")
        if isinstance(diff, dict):
            return cast(dict[str, Any], diff)
        return None


VerdictKind = Literal["pass", "fail", "error"]


@dataclass(frozen=True, slots=True)
class Verdict:
    verdict: VerdictKind
    score: float
    threshold: float
    question: str
    model: str
    raw: dict[str, Any]

    @property
    def passed(self) -> bool:
        return self.verdict == "pass"

    @property
    def reason(self) -> str | None:
        for key in ("reason", "explanation", "rationale"):
            value = self.raw.get(key)
            if isinstance(value, str) and value:
                return value
        return None

    @classmethod
    def from_wire(cls, data: dict[str, Any]) -> Verdict:
        return cls(
            verdict=data.get("verdict", "fail"),  # type: ignore[arg-type]
            score=float(data.get("score", 0)),
            threshold=float(data.get("threshold", 0)),
            question=str(data.get("question") or ""),
            model=str(data.get("model") or ""),
            raw=dict(data),
        )
