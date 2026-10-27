# with-resource-limits

**Shows:** the container's memory, swap, CPU and process limits. The environment's
`docker({ memory: '1g', swap: 0, cpus: 1, pids: 256 })` runs the agent on a smaller machine than the
defaults (4g, 2 CPUs, 1024 processes), and the eval checks the memory limit applies. A process
that goes past it is killed, and the attempt is an infra error, whatever its checks said.

**Needs:** Docker on cgroup v2, even for the fake agent, since the memory check reads
`/sys/fs/cgroup/memory.max` (`docker info` says `Cgroup Version: 2`); in this repo, run `pnpm install && pnpm build` at the
root first. A real agent also needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code)
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; it still runs in the limited container. `pnpm eval --profile
claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** what happens past the limit. Here a check was added that allocates memory
until it's killed:

```text
infra error      adds multiply on a small machine
  toHaveFile src/math.js  not run
  toSucceed node --test   not run
  memory limit            not run
  infra error             out of memory: 1 process killed at the 1g limit; raise docker({ memory })
```

reeval reads the container's out-of-memory kills at teardown and records them in the attempt's
`error.resource`; `reeval query "SELECT attempt_key, oom_kills FROM failing_attempts"` lists them.
The limits set how the container runs, not what's in its image, so changing them never rebuilds
one.

| File | What it is |
|---|---|
| [`with-resource-limits.eval.ts`](./with-resource-limits.eval.ts) | The eval: the limited environment, one prompt, three checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Each limit and its default is in [Configure Docker sandboxes](../../docs/configuration/sandboxes/docker.mdx), and why the
container is locked down in [Choose a sandbox](../../docs/configuration/sandboxes/index.mdx).
