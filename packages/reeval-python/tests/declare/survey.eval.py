from reeval_python import define_environment, evaluate, survey

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})


@survey("which database", {"runs": 3})
async def which_database(c): ...


@survey(
    "which database with the skill",
    {"compare": {"control": base, "variants": [skilled]}, "runs": 4},
)
async def with_skill(c): ...


@survey("which framework", {"cases": ["chat", "rag"]})
async def which_framework(c, case): ...


@evaluate("ungated on its own", {"gate": "none", "runs": 2})
async def ungated(c): ...
