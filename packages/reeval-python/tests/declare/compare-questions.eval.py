from reeval_python import define_environment, evaluate

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})
terse = base.extend("terse", {"env": {"MODE": "terse"}})


@evaluate(
    "one question",
    {
        "compare": {
            "baseline": base,
            "variants": [skilled],
            "questions": ["Which handles state more cleanly?"],
        }
    },
)
async def one_question(c): ...


@evaluate(
    "two questions, one with its own model",
    {
        "compare": {
            "baseline": base,
            "variants": [skilled, terse],
            "questions": [
                "Which handles state more cleanly?",
                {
                    "question": "Which follows the house style more closely?",
                    "model": "google/gemini-3.8-flash",
                },
            ],
        }
    },
)
async def two_questions(c): ...


@evaluate(
    "pinned",
    {
        "compare": {"baseline": base, "variants": [skilled], "questions": ["Which is shorter?"]},
        "pin": ["compare"],
    },
)
async def pinned(c): ...
