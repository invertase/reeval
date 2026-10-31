from reeval_python import define_environment, evaluate

next_app = define_environment("next-app", {"traits": {"stack": "next", "auth": ["clerk", "none"]}})
clerk = next_app.extend("next-clerk", {"traits": {"auth": "clerk"}})
plain = next_app.extend("next-plain", {"env": {"MODE": "plain"}})


@evaluate("traits", {"environments": [next_app, clerk, plain]})
async def traits(c): ...
