from reeval_python import define_environment, evaluate

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})
terse = base.extend("terse", {"env": {"MODE": "terse"}})


@evaluate("control and two variants", {"compare": {"baseline": base, "variants": [skilled, terse]}})
async def control_and_two(c): ...


@evaluate(
    "every cell gated, with a minimum lift",
    {
        "compare": {"baseline": base, "variants": [skilled], "gate": "all", "min_lift": 0.2},
        "runs": 2,
    },
)
async def gated(c): ...
