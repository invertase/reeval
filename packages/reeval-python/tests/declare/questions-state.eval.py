from reeval_python import define_environment, evaluate

base = define_environment("base", {"env": {"MODE": "base"}})
skilled = base.extend("skilled", {"env": {"MODE": "skilled"}})


@evaluate(
    "transcript across harnesses",
    {
        "compare": {"baseline": base, "variants": [skilled]},
        "questions": [
            {
                "question": "Which agent verified its work?",
                "across": "harness",
                "transcript": "tools",
            }
        ],
    },
)
async def transcript_across_harnesses(c): ...


@evaluate(
    "transcript within a harness",
    {
        "compare": {"baseline": base, "variants": [skilled]},
        "questions": [
            {
                "question": "Which arm verified its work?",
                "across": "environment",
                "transcript": "tools",
            }
        ],
    },
)
async def transcript_within_a_harness(c): ...


@evaluate(
    "screenshots",
    {
        "compare": {"baseline": base, "variants": [skilled]},
        "questions": [
            {
                "question": "Which page looks better?",
                "across": "environment",
                "artifacts": ["landing"],
            }
        ],
    },
)
async def screenshots(c): ...


@evaluate(
    "each attempt with the transcript",
    {
        "questions": [
            {
                "question": "What did the agent check before it finished?",
                "task": True,
                "output": True,
                "diff": True,
                "transcript": True,
            }
        ]
    },
)
async def each_attempt_with_the_transcript(c): ...


@evaluate(
    "each attempt without the transcript",
    {
        "questions": [
            {
                "question": "What did the agent say it did?",
                "task": True,
                "output": True,
                "diff": True,
            }
        ]
    },
)
async def each_attempt_without_the_transcript(c): ...
