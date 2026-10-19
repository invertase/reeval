"""Mirror of packages/reeval/test/plan/selection/evals/tags.eval.ts for declare conformance."""

from reeval_python.declare import evaluate, evaluate_each, group


def declare_tags() -> None:
    group("slow things", {"tags": ["slow"]}, _slow_things)
    evaluate("quick", lambda _c: None)
    evaluate_each([{"n": 1}, {"n": 2}], "case $n", {"tags": ["slow"]})(lambda _c: None)


def _slow_things() -> None:
    evaluate("big", lambda _c: None)
    evaluate("bigger", {"tags": ["flaky"]}, lambda _c: None)
