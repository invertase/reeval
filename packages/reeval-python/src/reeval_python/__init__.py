"""Python eval authoring API for reeval (*.eval.py)."""

from reeval_python.context import AttemptContext, SyncAttemptContext
from reeval_python.declare import evaluate, group, todo
from reeval_python.environment import (
    DEFAULT_EGRESS_ALLOW,
    DockerSandbox,
    Environment,
    FakeHarness,
    FakeJudge,
    Plugin,
    PluginBuild,
    define_environment,
    docker,
    fake_harness,
    fake_judge,
    plugin,
)
from reeval_python.errors import ReevalAssertionError, ReevalCallError
from reeval_python.expect import Expectation, expect
from reeval_python.options import BestOf, CaseOptions, EvalOptions, JudgeDefaults, JudgeOptions
from reeval_python.types import BackgroundHandle, Diff, ExecResult, FileChange, Turn, Verdict

__all__ = [
    "DEFAULT_EGRESS_ALLOW",
    "AttemptContext",
    "BackgroundHandle",
    "BestOf",
    "Diff",
    "DockerSandbox",
    "Environment",
    "CaseOptions",
    "EvalOptions",
    "ExecResult",
    "Expectation",
    "FakeHarness",
    "FakeJudge",
    "FileChange",
    "JudgeDefaults",
    "JudgeOptions",
    "Plugin",
    "PluginBuild",
    "ReevalAssertionError",
    "ReevalCallError",
    "SyncAttemptContext",
    "Turn",
    "Verdict",
    "define_environment",
    "docker",
    "evaluate",
    "expect",
    "fake_harness",
    "fake_judge",
    "group",
    "plugin",
    "todo",
]
