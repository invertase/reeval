"""Python eval authoring API for reeval (*.eval.py)."""

from reeval_python.context import AttemptContext, SyncAttemptContext
from reeval_python.declare import collect_module_tree, evaluate, group, reset_collector
from reeval_python.errors import ReevalAssertionError
from reeval_python.expect import expect, soft
from reeval_python.types import BackgroundHandle, ExecResult, Turn, Verdict

__all__ = [
    "AttemptContext",
    "BackgroundHandle",
    "ExecResult",
    "ReevalAssertionError",
    "SyncAttemptContext",
    "Turn",
    "Verdict",
    "collect_module_tree",
    "evaluate",
    "expect",
    "group",
    "reset_collector",
    "soft",
]
