# with-env

**Shows:** plain variables for the sandbox, which the agent, setup and checks all see. The `shop`
environment sets `env: { NODE_ENV, CURRENCY }`, and `shop-eur` extends it with its own `CURRENCY`;
`env` merges by name, so it keeps `NODE_ENV`. The agent makes `price()` read `CURRENCY`, and the
eval runs it.

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

**What to look at:** `pnpm eval -v` traces each attempt. Its `env` lines name the variables the
sandbox got (never their values) and the one the child overrides:

```text
[prices#1 fake] 14:57:56 env       environment shop-eur (digest 9ce08b961dc1) · extends shop · overrides env.CURRENCY
[prices#1 fake] 14:57:56 env       vars CURRENCY, NODE_ENV · secrets none
…
```

Variables are for plain values: a name with `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL`
in it needs `secret.fromEnv`, and a literal there stops the run.

| File | What it is |
|---|---|
| [`with-env.eval.ts`](./with-env.eval.ts) | The eval: both environments, and three checks |
| [`project/`](./project) | The package the agent starts from: `src/price.js`, `bin/price.js` and a test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`env` and how `extendEnvironment` merges it are in the
[defineEnvironment](../../docs/reference/environment.mdx) reference.
