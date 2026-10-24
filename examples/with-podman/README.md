# with-podman

**Shows:** the same sandbox on Podman instead of Docker. The environment's `podman()` takes the same
options as `docker()` and runs the same locked-down container on Podman 4 or later. The agent adds
`multiply(a, b)` to a small package and the eval runs its tests.

**Needs:** Podman 4 or later, even for the fake agent; in this repo, run
`pnpm install && pnpm build` at the root first. Rootless Podman needs your user's cgroup to have
the `cpu` and `pids` controllers (below). A real agent also needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code) and `pnpm reeval image build --profile claude-code` once,
which builds into Podman's image store.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; it still runs in a Podman container. `pnpm eval --profile
claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts): the environment's `podman()` wins over the profile's
`docker()`.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the run names the sandbox `podman`:

```text
preparing 1 sandbox: podman
reeval 0.13.0 · run … · 1 eval file · harness fake · sandbox podman · concurrency 4 · stream logs

pass             adds a tested multiply function
```

Rootless Podman without those cgroup controllers stops the run before it starts, rather than run
without the limits:

```text
reeval: Rootless Podman can't limit a sandbox's cpu, pids: your user's cgroup doesn't have the cpu, pids controllers: delegate them with a systemd drop-in for user@.service (Delegate=cpu cpuset io memory pids), then log in again, and try again.
```

| File | What it is |
|---|---|
| [`with-podman.eval.ts`](./with-podman.eval.ts) | The eval: the Podman environment, one prompt, two checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

[podman()](../../docs/reference/sandbox/podman.mdx) has its options, macOS with `podman machine`,
and what reeval has been tested on.
