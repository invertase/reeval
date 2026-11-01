from reeval_python import define_environment, evaluate

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})


@evaluate("which database", {"gate": "observe", "runs": 3})
async def which_database(c): ...


@evaluate(
    "which database with the skill",
    {"compare": {"control": base, "variants": [skilled]}, "gate": "observe", "runs": 4},
)
async def with_skill(c): ...


@evaluate("which framework", {"cases": ["chat", "rag"], "gate": "observe"})
async def which_framework(c, case): ...


@evaluate(
    "the compare observes",
    {"compare": {"control": base, "variants": [skilled], "gate": "observe"}, "runs": 2},
)
async def compare_observes(c): ...
