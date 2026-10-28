"""Typed options for `evaluate`, `group` and `c.judge`, with reeval's keys in snake_case.

A duration (`timeout`) is seconds or a `timedelta`. The values nested inside an option are the
data reeval documents for it, in snake_case too, and reeval checks them when it plans the run.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import timedelta
from typing import Any, Literal, TypedDict

from reeval_python.environment import DockerSandbox, Environment, FakeHarness, FakeJudge

Harness = str | FakeHarness | Mapping[str, Any]


class JudgeDefaults(TypedDict, total=False):
    """Defaults for `c.judge()`, merged field by field down the cascade."""

    gateway: Literal["direct", "vercel", "openrouter"] | Mapping[str, Any]
    max_concurrent: int
    model: str | FakeJudge
    provider_options: Mapping[str, Mapping[str, Any]]
    threshold: float


class JudgeOptions(JudgeDefaults, total=False):
    """`c.judge()`'s options: the judge defaults, and what the call shows the judge.

    Every input is off unless the call turns it on, and a call turns on at least one of `task`,
    `output`, `files`, `diff`, `contents`, `transcript`, `checks` or `artifacts`. `turns` says
    whether they read every turn up to the graded one (`"all"`) or that turn alone.
    """

    task: bool
    output: bool
    files: bool
    diff: bool | Sequence[str]
    contents: Sequence[str]
    transcript: bool | Literal["tools", "full"]
    checks: bool | Sequence[str]
    artifacts: Literal[True] | Sequence[str]
    turns: Literal["last", "all"]


JUDGE_INPUTS = ("task", "output", "files", "diff", "contents", "transcript", "checks", "artifacts")


class EvalOptions(TypedDict, total=False):
    """Options for an eval or a group; a group's cascade to the evals inside it."""

    capture: Mapping[str, Any]
    compare: Mapping[str, Any]
    egress: Literal["allow-all", "deny-all", "proxy"] | Mapping[str, Sequence[str]]
    env: Mapping[str, Any]
    environment: Environment | Mapping[str, Any]
    gate: Literal["all"] | Mapping[str, float]
    harness: Harness | Sequence[Harness] | Mapping[str, Any]
    judge: JudgeDefaults
    pin: Sequence[str]
    question: Mapping[str, Any]
    questions: Sequence[Mapping[str, Any]]
    """Asked of each attempt, or between attempts with `across`; `[]` clears the group's. Each
    names what it's shown: `{"question": …, "diff": True}`, at least one input."""
    runs: int
    sandbox: DockerSandbox | Mapping[str, Any]
    revision: int | str
    """The eval's version, in its fingerprint: bump it when a helper, a constant outside the body
    or a fixture changes what it measures. A group's applies to evals inside that set none."""
    tags: Sequence[str]
    timeout: timedelta | float
    """Per attempt, in seconds or as a timedelta."""
