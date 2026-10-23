from reeval_python import define_environment, evaluate, group, plugin

fetched = define_environment(
    "fetched",
    {
        "plugins": [
            plugin.git("github:acme/agent-plugins", ref="v1.2.0", path="plugins/review"),
            plugin.npm("@acme/review-plugin@1.2.0", only=["skills"]),
        ]
    },
)
pinned = fetched.extend(
    "pinned",
    {
        "plugins": [
            plugin.git(
                "github:acme/agent-plugins",
                ref="v1.3.0",
                path="plugins/review",
                build={"run": ["pnpm install --frozen-lockfile", "pnpm build"], "cwd": "."},
            )
        ]
    },
)


def remote_plugins():
    @evaluate("git and npm read at the attempt")
    def git_and_npm(c): ...

    @evaluate("a child adds another", {"environment": pinned})
    def child(c): ...


group("remote plugins", {"environment": fetched}, remote_plugins)
