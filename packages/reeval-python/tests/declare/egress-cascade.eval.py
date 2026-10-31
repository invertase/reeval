from reeval_python import DEFAULT_EGRESS_ALLOW, define_environment, evaluate, fake_harness, group

closed = define_environment("closed", {"egress": "deny-all"})
reopened = closed.extend("reopened", {"egress": "allow-all"})
installs = define_environment(
    "installs", {"egress": {"allow": [*DEFAULT_EGRESS_ALLOW, "api.example.com"]}}
)
plain = define_environment("plain", {})


async def body(c): ...


evaluate("the config policy", body)
evaluate("an environment replaces it", {"environments": closed}, body)
evaluate("an extend child replaces its parent", {"environments": reopened}, body)
evaluate("the default list spreads", {"environments": installs}, body)
evaluate(
    "the eval replaces the environment",
    {"environments": closed, "egress": {"allow": ["eval.example.com"]}},
    body,
)


def a_group():
    evaluate("replaces the environment too", {"environments": closed}, body)


group("a group", {"egress": {"allow": ["group.example.com"]}}, a_group)
evaluate(
    "a variant runs under its own policy",
    {"compare": {"baseline": plain, "variants": [closed]}},
    body,
)
evaluate(
    "a fake agent with a layout gets that agent's hosts",
    {"environments": closed, "harnesses": fake_harness(layout="claude-code")},
    body,
)
