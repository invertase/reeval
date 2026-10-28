from reeval_python import define_environment, evaluate

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})
terse = base.extend("terse", {"env": {"MODE": "terse"}})


@evaluate(
    "one question",
    {
        "compare": {"baseline": base, "variants": [skilled]},
        "questions": [
            {"question": "Which handles state more cleanly?", "across": "environment", "diff": True}
        ],
    },
)
async def one_question(c): ...


@evaluate(
    "two questions, one with its own model",
    {
        "compare": {"baseline": base, "variants": [skilled, terse]},
        "questions": [
            {
                "question": "Which handles state more cleanly?",
                "across": ["environment", "harness"],
                "diff": True,
            },
            {
                "question": "Which follows the house style more closely?",
                "model": "google/gemini-3.8-flash",
                "across": "environment",
                "diff": True,
            },
        ],
    },
)
async def two_questions(c): ...


@evaluate(
    "pinned",
    {
        "compare": {"baseline": base, "variants": [skilled]},
        "questions": [{"question": "Which is shorter?", "across": "environment", "diff": True}],
        "pin": ["compare"],
    },
)
async def pinned(c): ...
