from reeval_python import define_environment, evaluate, group

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})
terse = base.extend("terse", {"env": {"MODE": "terse"}})


def asked_by_the_group():
    @evaluate("inherits the question")
    async def inherits(c): ...

    @evaluate("also inherits it", {"runs": 2, "gate": {"pass_rate": 0.5}})
    async def also_inherits(c): ...

    @evaluate("replaces the compare", {"compare": {"baseline": base, "variants": [terse]}})
    async def replaces_the_compare(c): ...

    @evaluate("replaces the questions", {"questions": ["What did the agent change?"]})
    async def replaces_the_questions(c): ...

    @evaluate("asks none", {"questions": []})
    async def asks_none(c): ...


group(
    "asked by the group",
    {
        "compare": {"baseline": base, "variants": [skilled]},
        "questions": [{"question": "Which handles state more cleanly?", "across": "environment"}],
    },
    asked_by_the_group,
)


def pairs_its_evals_compares():
    @evaluate("compares", {"compare": {"baseline": base, "variants": [skilled]}})
    async def compares(c): ...

    @evaluate("skipped without a compare", mode="skip")
    async def skipped(c): ...


group(
    "pairs its evals' compares",
    {"questions": [{"question": "Which is shorter?", "across": "environment"}]},
    pairs_its_evals_compares,
)
