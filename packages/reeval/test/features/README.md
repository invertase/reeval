# Feature fixtures

Each directory here is a small reeval project that checks **one** behaviour of one feature, from
inside the attempt, with reeval's own API. `features.test.ts` runs it and checks the record from
outside. Every user-facing feature or option lands with its fixtures in the same change.

## Which tier

| The feature changes… | Add |
|---|---|
| which evals, cells, attempts or notes a run plans (options, profiles, selection, compare, images) | a plan case in `plan.test.ts`: a new directory under `test/plan/`, or a case on an existing one |
| what lands in or happens inside an attempt (environment fields, sandbox behaviour, harness inputs, the `t` API) | a fixture here: one check and one canary |
| … and touches Docker, images, egress, ports or brokering | list it with `tiers: ['fake', 'docker']` (only `docker` if the fake can't model it) |
| what a real harness receives (skills, MCP, rules, auth) | also list the `real` tier: the same fixture on real Cursor (see Running) |
| runner behaviour (exit codes, output, history, cancel, budget, redaction) | a plain `node:test` case in the matching existing test file |
| a new error message | a row in the `common mistakes` table in `options.test.ts` |

## Shape of a fixture

```text
<area>/<what-it-checks>/        e.g. skills/exclude-custom, not skills-2
  reeval.config.ts                  REEVAL_FIXTURE_SANDBOX picks the fake sandbox or docker()
  evals/env.ts                  the environment both evals use
  evals/lands.eval.ts             the check: one evaluate, one expectation
  evals/canary.eval.ts            the same check with a wrong expectation: it must fail
  …                             whatever the feature needs (skills/, files)
```

- One `evaluate` per file and one behavioural expectation. A feature with two properties (the
  file set and the content, say) gets two fixtures.
- The canary makes the same check with one deliberate mistake, so it fails with an assertion.
  That proves the check can fail. The oracle matches its message, so it also fails for the right
  reason.
- Then add a row to `features` in `features.test.ts`:
  - `dir` and `tiers`;
  - `env`: the environment's name, since attempt ids are `fake/<env>/<sandbox>#1`;
  - `canary`: a regex for the canary's failure message;
  - optionally `prepare` (for example, making a git repo) and `record`, a host-side cross-check
    of the run record.
- The table test fails if a directory here is missing from the table, or lacks either eval.

## The inventory and COVERAGE.md

Every user-facing feature has an entry in [`inventory.ts`](./inventory.ts): an id, its area, its
name as the docs give it, and what covers it. That's `fixtures` (directories here), `plan` cases
(`dir/name`) and `tests` (`<path under packages/> › <test title>`). [`COVERAGE.md`](./COVERAGE.md)
is the feature × tier matrix (unit, plan, fake, docker, real) generated from it, the table in
`features.test.ts` and the cases in `plan.test.ts`. CI writes the same matrix to the job summary.

- **A new feature adds its entry** in the same change, naming the fixtures, plan cases or tests
  that cover it. Every fixture and plan case must be named by some entry.
- **A feature that nothing covers yet** needs `gap: '<why>'`. Once something covers it, delete
  the gap.
- `pnpm features:matrix --write` regenerates `COVERAGE.md`. `matrix.test.ts` fails on anything
  above that's missing, on a name that doesn't exist, and when `COVERAGE.md` is stale.

## Checks without an agent, and checks as the agent

- **Checks on what the environment set up** (files, rules, skills, setup steps) don't need a
  turn: `const box = await t.sandbox()` starts the sandbox, and then `box.exec` and
  `box.readFile` work (so do `t.exec` and `t.readFile`).
- **What the agent itself sees** differs from what `t.exec` sees: checks get `to: 'checks'`
  secrets, and the agent doesn't. Script the fake agent in `reeval.config.ts` with real sandbox
  actions, then assert on its transcript:

  ```ts
  harness: fakeHarness({ script: [[{ exec: 'printenv CHECK_TOKEN || echo unset' }]] })
  // in the eval: the shell call's stdout
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
  ```

  There's one step list per `t.send`, and the last list repeats. The steps are `{ exec }`,
  `{ write: { path: content } }`, `{ reply }` and `{ mcp: '<server>/<tool>' }`, which starts the
  environment's stdio MCP server in the sandbox and calls the tool, reported as
  `mcp__<server>__<tool>`.
- The fake agent writes **harness-placed skills** to `~/.agents/skills/<name>/`, where the Cursor
  adapter puts them. Whether Cursor itself reads them from there is a question for the Docker
  and real-agent tiers.
- **Egress fixtures** (`egress/*`) list only `docker` (and `real`): the fake sandbox can't
  enforce a policy, so a restricted one makes its plan exit 2. For a host to reach,
  `features.test.ts` starts a listener on the host at a non-loopback address (the gateway never
  reaches loopback) that answers `reeval-egress-ok`; a row passes `hostEnv: egressEnv` to give the
  fixture `REEVAL_EGRESS_HOST` (its address) and `REEVAL_EGRESS_TARGET` (address and port). The row's
  `record` checks the attempt's `egress` from outside.
- **Per-harness behaviour without a key:** `fakeHarness({ layout: 'claude-code' })` (or
  `'cursor'`) places rules and skills exactly where that agent reads them and runs in that
  agent's image, so a fixture under `harness/` covers what a real harness receives. List the
  fixture's `image` in its row when it isn't Cursor's, so the Docker tier knows what to need.

## The real tier

A fixture that lists `real` also runs on real Cursor in Docker: its `reeval.config.ts` picks
`cursor({ model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5' })` when `REEVAL_FIXTURE_HARNESS=cursor`.
The tier is skipped unless `REEVAL_TEST_REAL=1`, and then needs `CURSOR_API_KEY`: without it each fixture
fails, naming the variable. Its fixtures run one
at a time, at `--concurrency 1`, and spend money, so keep them cheap:

- One short turn per eval, with a prompt that names the exact action ("run `cat …` once").
- The check reads something the model can't fake: a file a tool wrote, the agent's own tool
  output, or the record (`context`, taken after the first turn, lists the adapter's home).
- A canary that needs no turn (`await t.sandbox()`) when the check allows it; else one short turn.
- A fixture whose behaviour only a real agent has (rules reaching its context) lists `real` alone,
  next to the fake/Docker fixture that checks where reeval put the file.

What every real harness must do, on each of them, is the **harness contract**
([`../contract/README.md`](../contract/README.md)): a table of behaviours run once per harness
row. A feature a real harness receives (skills, rules, MCP, auth, egress, the record) adds a
behaviour there when it applies to every harness, and names it in its inventory entry's `real`
(`contract › <behaviour>`); a harness-specific check stays a fixture here.

## Running

```bash
pnpm build                              # the tests run dist/cli.js; rebuild after changing src/
cd packages/reeval
pnpm test:plan                          # plan snapshots
pnpm test:features                      # fixtures on the fake sandbox, and Docker if it's there
pnpm test:docker                        # Docker only, failing (not skipping) without it
pnpm test:real                          # real Cursor fixtures, one at a time (CURSOR_API_KEY)
REEVAL_UPDATE_SNAPSHOTS=1 pnpm test:plan    # accept plan changes, then review the diff
pnpm test                               # everything, before finishing
```

To debug one fixture by hand, run with `REEVAL_TEST_KEEP=1` to keep the temp project, then `cd` into
it and run `reeval run --ui plain`. Add `REEVAL_FIXTURE_SANDBOX=docker` for the Docker tier.

## Done means

1. The new fixtures pass in every tier they list, on the machine that built the feature. That
   includes Docker when the feature touches it.
2. Each canary fails, with the message its row expects.
3. Plan snapshot diffs are reviewed and show only the intended change.
4. `pnpm test`, `pnpm lint` and `pnpm typecheck` are green, with no Docker test skipped when the
   feature touches Docker.
5. The change lists the fixtures it adds, and its entry in `inventory.ts` names them (or says why
   it's a gap), with `COVERAGE.md` regenerated.
6. The docs are updated: the feature's page in the Reference tab (`docs/reference/`), and the
   Guide or a Recipe if it changes how people use reeval. `pnpm docs:check` is green (see
   [AGENTS.md](../../../../AGENTS.md#docs)).
