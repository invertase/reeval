from reeval_python import define_environment, docker, evaluate

parent = define_environment("parent", {"sandbox": docker(from_="node:22-bookworm")})
child = parent.extend("child", {"sandbox": docker(from_="node:24-bookworm")})
kept = parent.extend("kept", {"env": {"MODE": "x"}})


def body(c): ...


evaluate("parent image", {"environment": parent}, body)
evaluate("child replaces sandbox", {"environment": child}, body)
evaluate("child keeps parent sandbox", {"environment": kept}, body)
