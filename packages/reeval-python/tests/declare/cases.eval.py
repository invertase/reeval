from reeval_python import define_environment, evaluate

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})


@evaluate(
    "pooled",
    {
        "cases": ["ada", "grace", "linus"],
        "compare": {"control": base, "variants": [skilled], "min_lift": 0.2},
    },
)
async def pooled(c, who): ...


@evaluate(
    "keyed",
    {
        "cases": [{"who": "ada"}, {"who": "grace"}],
        "case_key": lambda c: c["who"],
        "compare": {"control": base, "variants": [skilled]},
    },
)
async def keyed(c, case): ...


@evaluate("one case is not pooled", {"cases": ["only"]})
async def one_case(c, case): ...
