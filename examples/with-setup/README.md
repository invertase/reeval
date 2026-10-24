# with-setup

**Shows:** setup steps that run in every attempt before the agent starts, and don't count as its
change. `setup` seeds `data/users.json` with a script and runs the tests (one step a string, one
`{ run, timeout }`); the agent writes a script that counts the active users, and the eval runs it
and checks the seeded file isn't in the turn's diff.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** each attempt's `setup.log`, in its directory under `.reeval/runs/<run>/`. A
step that fails stops the attempt as an infra error, before the agent runs:

```text
$ node scripts/seed.mjs
exit 0 after 25ms

$ node --test
exit 0 after 81ms
TAP version 13
# Subtest: loadUsers reads the seeded users
ok 1 - loadUsers reads the seeded users
…
```

| File | What it is |
|---|---|
| [`with-setup.eval.ts`](./with-setup.eval.ts) | The eval: the environment's setup steps, and two checks |
| [`project/`](./project) | The package the agent starts from, with `scripts/seed.mjs` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`setup` and the order an attempt applies an environment in are in the
[defineEnvironment](../../docs/reference/environment.mdx) reference.
