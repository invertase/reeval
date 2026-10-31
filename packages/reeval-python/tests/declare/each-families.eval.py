from reeval_python import define_environment, evaluate_each

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})


@evaluate_each(
    ["ada", "grace", "linus"],
    "pooled across %s",
    {"compare": {"control": base, "variants": [skilled], "min_lift": 0.2}},
)
async def pooled(c, who): ...


@evaluate_each(
    [{"who": "ada"}, {"who": "grace"}],
    "each on its own for $who",
    {"compare": {"control": base, "variants": [skilled]}},
    pool=False,
)
async def on_its_own(c, case): ...


@evaluate_each(["only"], "one case is not a family: %s")
async def one_case(c, case): ...
