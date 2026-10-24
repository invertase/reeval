# with-guarded-files

**Shows:** failing an agent that touches files it was told to leave alone. The agent adds
`clamp(n, min, max)` to a small package with no new dependencies, and the eval guards
`package.json` and `package-lock.json` with `expect(c).not.toHaveChanged([…])` before running the
tests.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `--profile canary` is a fake agent that does the same work but
also adds a dependency to `package.json`, from [`canary/`](./canary). `pnpm eval --profile
claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval --profile canary`. The canary's `clamp` and tests are right, so
only the guard catches it, and the run exits 1:

```text
fail             adds clamp without new dependencies
  dependencies untouched  failed
    expected no changes to package.json, package-lock.json, got ["package.json" (modified)]
```

`not.toHaveChanged` reads the workspace diff, so a write from a shell command such as
`npm install` counts too. `toHaveEdited` reads the transcript instead, and isn't a guard.

| File | What it is |
|---|---|
| [`with-guarded-files.eval.ts`](./with-guarded-files.eval.ts) | The eval: one prompt, the guard and the tests |
| [`project/`](./project) | The package the agent starts from: `src/math.js`, its test, `package.json` and its lockfile |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`canary/`](./canary) | The canary's `package.json`, with a dependency added |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, the `canary` profile, and the real agents from `../profiles.ts` |

`toHaveChanged` is in the [Matchers](../../docs/reference/matchers.mdx) reference.
