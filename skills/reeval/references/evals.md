# Evals: the attempt API, judges and matchers

## Contents

- Families: `evaluate.each`
- The attempt: `c.send`, `c.exec`, `c.serve`, files
- The judge: inputs, input size, errors
- Trustworthy evals
- Matchers

## Families: `evaluate.each`

- `evaluate(name, [options,] fn)` and `group(name, [options,] fn)`; also `.skip`, `.only`
  (an error in CI), `.todo`, and `evaluate.each(cases)(name, [options,] (c, item) => …)` (`$key`,
  `%s`, `%#` in the name). The eval id is `file › group › name`; renaming an eval restarts its history.
- `evaluate.each` with two or more cases pools them into a family (id `file › group › template`):
  one pass rate over the cases and, with `compare`, one lift paired by case, which `minLift` gates
  (not each case's). Prefer it to separate evals when the cases are one population: six cases at
  `runs: 1` can reach a lift verdict where each case alone is within noise. Fewer than six
  discordant cases reads `can't tell yet` (`insufficient` in `reeval query family_lift`), so a family needs six cases or more; the plan hints when it has fewer. `evaluate.each(cases, { pool: false })` keeps the cases
  independent; eval options go after the name, never beside the cases.
  A comment on an eval describes the current check (why a canary fails, which path it reads),
  not what used to be true or which product a prompt was ported from.

## The attempt: `c.send`, `c.exec`, `c.serve`, files

- `await c.send(prompt)` runs one agent turn and returns a `Turn` (`text`, `status`, `diff`,
  `transcript`). Call it again for multi-turn;
  `c.judge(q, { on: firstTurn, task: true, output: true })` grades an earlier one.
- `await c.exec(cmd)` returns `{ exitCode, stdout, stderr }`; `c.exec(cmd, { background: true })`
  starts it without waiting and returns `{ kill() }`. `c.exec(cmd, { retries: 2, interval: 2000 })`
  runs a command that exits non-zero again, up to 2 more times 2 s apart, and resolves with the
  last try: for a check that can fail on a transient, such as a test calling a model. Any non-zero
  exit retries (reeval doesn't read the output), and a last failed try is a failed check. `await c.serve(cmd, port?)` is that plus a
  port (`PORT` / `$PORT` on a bash string). `c.capture()` screenshots it: see
  [capture.md](capture.md).
- `await c.readFile(path)` the text or `null` (`~/` for home). `await c.writeFile(path, text)`
  places a file after a turn (a hidden test the agent never saw) instead of seeding it in
  `files`; later turns' `diff` leaves it out but shows any change the agent makes to it, even
  under `.gitignore`. Don't place grading files with a `c.exec` heredoc: the next turn's diff
  (and the judge) would count them as the agent's. The sandbox and session start on the first
  call that needs them (`c.send`, `c.exec`, `c.readFile`, `c.writeFile`, `c.serve`,
  `c.capture`), so a check before any turn sees what the environment set up.
  `c.attempt.cell.role` is
  `'control'` or `'variant'`.

## The judge: inputs, input size, errors

- `await c.judge(question, options)`: the judge sees the question and only the inputs the call
  turns on. Every input is off until the call sets it, and a call needs at least one (`true`, a
  mode or a non-empty list); there are no defaults, and the config, profile, group and eval
  `judge` take only `model`, `threshold`, `providerOptions`, `maxConcurrent` and `gateway`.
  With none, `c.judge()` throws before any model call, and TypeScript refuses it.

  | Input | Shows |
  |---|---|
  | `task: true` | the graded turn's prompt |
  | `output: true` | the graded turn's final message, or `on`'s value |
  | `files: true` | `status path` lines for the changed files, under `diff`'s patterns |
  | `diff: true` / `['src/**', '!**/*.test.ts']` | the diff since the eval started (gitignore-style, last match wins) |
  | `contents: ['README.md', 'src/**']` | files whole, changed or not; they leave the diff |
  | `transcript: true` / `'tools'` / `'full'` | the turn's transcript: clipped, tool calls only, everything |
  | `checks: true` / `['npm test']` | `c.exec` results, or those commands' |
  | `artifacts: true` / `[shot, 'home']` | captures, sent as file parts |

  Pick the inputs the question needs, usually one or two: a question about code reads `diff` or
  `contents`, one about the agent's answer `output`, one about how it worked `transcript`, one
  about a screenshot `artifacts`. Spell out `{ task: true, output: true, diff: true }` only when
  the question needs all three. The diff leaves out dependencies, build output (`dist/`,
  `.next/`, top-level `build/` and `out/`), lockfiles, `*.map`, `*.tsbuildinfo` and minified
  files.
- `on` and `turns` select what `task`, `output`, `transcript` and `diff` read and show nothing alone:
  `on: turn` grades an earlier turn, `on: value` grades any value as the output (with
  `output: true`), and `turns: 'all'` adds every turn before the graded one. `judge-input.json`
  records each call's `stateOptions` (every input, `false` when off) and the `state` it sent.
- Ask about facts in a captured picture, not whether it "looks great". Jev
  (`typesafe-ai/jev-1.14.0`) takes PNG captures; a provider that cannot take files fails that
  call. Prefer deterministic checks for what can be checked; use the judge for quality, with
  plain yes/no questions that don't name one specific way of doing it.
- Give the environment a `.gitignore` in `files` (the project's isn't copied in): an agent that
  runs a build otherwise fills the judge's diff with its output. reeval sends every input the
  call turns on, uncut, and knows no model's limit: a provider error keeps the provider's wording
  and adds one line with the input's estimated size, biggest files and the inputs that were on,
  largest first; narrow one, e.g. `{ diff: ['src/'] }`.
- A failed judge call doesn't throw: `c.judge()` returns `{ verdict: 'error', score: null, error }`,
  the later judges and checks still run, and the attempt fails as a judge error at the end.
  `expect(await c.judge(q, { diff: true }), name).toPass()` records each judge's result and
  carries on.

## Trustworthy evals

Before a real run, prove each check can pass and fail with the fake harness in the eval's real
sandbox: an oracle `fakeHarness` that does the task right (must pass) and a canary that cheats
or gets it wrong (must fail). A canary that passes means a check isn't checking. Give each check
you rely on a canary that only it catches.

```ts
// reeval.config.ts: the real harness, plus two profiles that swap only the harness and judge
export default defineConfig({
  harness: cursor({ model: 'composer-2.5' }),
  profiles: {
    oracle: {
      defaults: {
        harness: fakeHarness({ files: { 'greet.js': 'export const greet = …' } }),
        judge: { model: fakeJudge({ score: 0.95 }) },
      },
    },
    canary: {
      defaults: {
        harness: fakeHarness({ files: { 'greet.test.js': "test('greets', () => {})\n" } }),
        judge: { model: fakeJudge({ score: 0.1 }) },
      },
    },
  },
})
```

```bash
npx reeval image build --profile oracle   # once: the eval's images
npx reeval run --profile oracle           # every check passes, exit 0
npx reeval run --profile canary           # the checks you meant fail, exit 1
```

- Set `defaults.harness`, never `defaults.sandbox`: the environment's `docker()` (image,
  `install`, egress, brokered secrets) stays, so the checks run where they will for real. A
  profile's `sandbox` only fills in for an environment that omits one, and the fake harness
  without `layout` uses Cursor's image; `layout: 'claude-code'` (or another agent id) uses that
  agent's image and reads rules and skills where it does.
- `script` steps (`{ exec }`, `{ write }`, `{ mcp }`) run inside the container as the agent, so an
  oracle can run the real fix (`{ exec: 'node scripts/solve.mjs' }`) or call a brokered API.
- `fakeJudge` checks the wiring (a low score fails the check); keep the real `judge.model` on the
  oracle, with its key, to check that a question passes good work.
- `fakeSandbox()` isn't the oracle's sandbox: it runs on the host, brokers nothing and enforces no
  egress. It's for trying reeval and testing configs without Docker.
- An eval or group that sets its own `harness` keeps it (the plan notes `harness set by the
  eval`), and an ungated cell's (`compare: { gate: 'none' }`, a control's) failed checks don't change the
  exit code: its row in the result block shows its count (`plain  0 of 4`).

Keep grading out of the
agent's reach: place hidden tests after the turn with `c.writeFile`, so the agent never sees
them, seed tests in `files` only when the agent should see them, and guard seeded files
with `expect(await c.readFile(path)).toBe(original)`. `not.toHaveEdited(path)` is not a guard:
a read of the file trips it and a script's write slips past. When the behavior is the
outcome, judge the program's output, not the diff:
`c.judge(q, { on: (await c.exec('node app.js')).stdout, output: true })`. Checks run in the agent's
container as the same user, which suits AX evals but isn't a sealed verifier.

## Matchers

- `await expect(turn).toHaveFile(path, pattern?)`,
  `await expect(c.exec(cmd)).toSucceed()`, `expect(verdict).toPass()`,
  `expect(turn).toHaveSearched(query?)` / `toHaveFetched(url?)` (sync; they throw
  `HarnessCapabilityError` when `turn.unreported` lists web events; a refused
  search is still a `web-search` with `ok: false`), plus Vitest's.
- Transcript matchers (sync, no `await`): `expect(turn | c).toHaveCalledSkill(name)`,
  `toHaveCalledMcp(server, tool, input?)`, `toHaveCalledTool(name | RegExp, input?)`,
  `toHaveRun(command?)`, `toHaveEdited(path?)`, `toHaveSearched(query?)`,
  `toHaveFetched(url?)`. `.not` is Vitest's. `toHaveCalledSkill`
  is opened or loaded (a `skill` / `load_skill` tool, or a Read/`sed` of
  `skills/<name>/`), not "followed". MCP is `toHaveCalledMcp(server, tool)`
  (the names in `mcp.<server>`); `toHaveCalledTool('mcp__<server>__<tool>')` is
  the raw transcript name. After adapters and the normalizer, that string is
  the same on every harness (stdio; Goose, OpenCode, pi and Codex refuse
  `mcp.sse`). Use `toHaveEdited` / `toHaveSearched`, not
  `toHaveCalledTool('edit')` or `'webSearch'`.
- Guard files the agent must leave alone with `expect(c).not.toHaveChanged(['test/**',
  'package.json'])` (sync): it reads the workspace diff, so a shell or subprocess write counts
  and a read doesn't. Strings are globs (a directory matches everything under it), RegExps work,
  and a turn means up to that turn. `toHaveEdited` reads the transcript; don't use it as a guard.
- Checks don't stop the eval: a failed `expect` is recorded and the body carries on, so every
  later check and judge still runs; the attempt fails at its end. Use `expect.require` for gates:
  its failure ends the body there (`await expect.require(c.exec('npm run build'), 'builds')
  .toSucceed()`, `expect.require.poll(…)` for one that waits). One the eval catches still fails
  the attempt, and its error says the eval caught it. Only matcher failures carry on: an error
  the body throws, a dead sandbox or a timeout ends the attempt. Wait or retry with `expect.poll`
  (`await expect.poll(() => c.exec(cmd), { timeout: 10_000 }).toSucceed()`), which records one
  check with its final outcome, not with `expect` in a `try` loop.
- **Label each requirement** with `expect`'s second argument:
  `await expect(c, 'exports greet').toHaveFile('greet.js', /export/)`. Every matcher call
  is recorded (`evals[].attempts[].assertions`; unlabeled ones get `<matcher> <first arg>`).
  Changing a label changes the eval's fingerprint. Label judges too
  (`expect(await c.judge(q, { diff: true }), 'Social OAuth').toPass()`): the label replaces the clipped
  question in judge rates, `reeval show`, `summary.md` and the digest.
