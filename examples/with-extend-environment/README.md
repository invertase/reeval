# with-extend-environment

**Shows:** layering one environment on another. `math` seeds a small package and runs its tests in
`setup`; `math.extendEnvironment('math-with-docs', …)` adds the API conventions in
`docs/api.md` and a setup step of its own. Files merge by path (the child wins on a shared one) and
setup steps concatenate, parent first. The agent adds `multiply(a, b)` the way the docs say, and a
hidden test placed after the turn checks it.

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

**What to look at:** `pnpm eval -v` traces each attempt. Its `env` lines show the child's parent,
the files from both layers, and both setup steps in order:

```text
[follows#1 fake] 14:58:39 env       environment math-with-docs (digest e20982cf2029) · extends math
…
[follows#1 fake] 14:58:39 env       file package.json (69 bytes)
[follows#1 fake] 14:58:39 env       file src/math.js (45 bytes)
[follows#1 fake] 14:58:39 env       file test/math.test.js (163 bytes)
[follows#1 fake] 14:58:39 env       file docs/api.md (216 bytes)
[follows#1 fake] 14:58:39 env       setup 1/2 $ node --test → exit 0 · 77ms
[follows#1 fake] 14:58:39 env       setup 2/2 $ test -f docs/api.md → exit 0 · 14ms
[follows#1 fake] 14:58:39 env       workspace snapshot taken: the diff starts here
```

| File | What it is |
|---|---|
| [`with-extend-environment.eval.ts`](./with-extend-environment.eval.ts) | The eval: the parent, the child and the check |
| [`docs/api.md`](./docs/api.md) | The conventions the child adds |
| [`hidden/multiply.test.js`](./hidden/multiply.test.js) | The test the eval places after the turn, which the agent never sees |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

How each field merges is in the [defineEnvironment](../../docs/reference/environment-helpers.mdx#extend)
reference.
