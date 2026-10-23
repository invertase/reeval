"""Python eval authoring API for reeval (*.eval.py)."""

from reeval_python.context import AttemptContext, SyncAttemptContext
from reeval_python.declare import (
    collect_module_tree,
    evaluate,
    evaluate_each,
    group,
    reset_collector,
    todo,
)
from reeval_python.environment import (
    DEFAULT_EGRESS_ALLOW,
    Environment,
    PluginBuild,
    define_environment,
    docker,
    fake_harness,
    fake_judge,
    plugin,
)
from reeval_python.errors import ReevalAssertionError, ReevalCallError
from reeval_python.expect import expect, soft
from reeval_python.types import BackgroundHandle, ExecResult, Turn, Verdict

__all__ = [
    "DEFAULT_EGRESS_ALLOW",
    "AttemptContext",
    "BackgroundHandle",
    "Environment",
    "ExecResult",
    "PluginBuild",
    "ReevalAssertionError",
    "ReevalCallError",
    "SyncAttemptContext",
    "Turn",
    "Verdict",
    "collect_module_tree",
    "define_environment",
    "docker",
    "evaluate",
    "evaluate_each",
    "expect",
    "fake_harness",
    "fake_judge",
    "group",
    "plugin",
    "reset_collector",
    "soft",
    "todo",
]
