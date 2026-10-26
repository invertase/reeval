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
    state: Mapping[str, Any]
    threshold: float


class JudgeOptions(JudgeDefaults, total=False):
    """`c.judge()`'s options: the judge defaults, plus the captures it sends."""

    artifacts: Literal[True] | Sequence[str]


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
    questions: Sequence[str | Mapping[str, Any]]
    """Asked of each attempt, or between attempts with `across`; `[]` clears the group's."""
    runs: int
    sandbox: DockerSandbox | Mapping[str, Any]
    revision: int | str
    """The eval's version, in its fingerprint: bump it when a helper, a constant outside the body
    or a fixture changes what it measures. A group's applies to evals inside that set none."""
    tags: Sequence[str]
    timeout: timedelta | float
    """Per attempt, in seconds or as a timedelta."""
