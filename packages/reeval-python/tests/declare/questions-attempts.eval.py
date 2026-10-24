from reeval_python import define_environment, evaluate

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})


@evaluate("asked of each attempt", {"questions": ["How did the agent find the failing test?"]})
async def asked_of_each_attempt(c): ...


@evaluate(
    "with choices",
    {
        "runs": 2,
        "gate": {"pass_rate": 0.5},
        "questions": [{"question": "Did the agent run the tests first?", "choices": ["yes", "no"]}],
    },
)
async def with_choices(c): ...


@evaluate(
    "beside a compare",
    {
        "compare": {"baseline": base, "variants": [skilled]},
        "questions": [
            "What did the agent read first?",
            {"question": "Which is cleaner?", "across": "environment"},
        ],
    },
)
async def beside_a_compare(c): ...


@evaluate(
    "across harnesses without a compare",
    {"questions": [{"question": "Which agent explained its change better?", "across": "harness"}]},
)
async def across_harnesses_without_a_compare(c): ...
