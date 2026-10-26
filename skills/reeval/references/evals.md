# Evals: the attempt API, judges and matchers

## Contents

- Families: `evaluate.each`
- The attempt: `c.send`, `c.exec`, `c.serve`, files
- The judge: options, `state`, input size, errors
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
  discordant cases reads `can't tell yet` (`insufficient` in `reeval query family_lift`). `evaluate.each(cases, { pool: false })` keeps the cases
  independent; eval options go after the name, never beside the cases.
  A comment on an eval describes the current check (why a canary fails, which path it reads),
  not what used to be true or which product a prompt was ported from.

## The attempt: `c.send`, `c.exec`, `c.serve`, files

- `await c.send(prompt)` runs one agent turn and returns a `Turn` (`text`, `status`, `diff`,
  `transcript`). Call it again for multi-turn; `c.judge(q, { on: firstTurn })` grades an earlier one.
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

## The judge: options, `state`, input size, errors

- `await c.judge(question, { threshold?, model?, on?, state?, artifacts? })`: by
  default the judge sees the prompt, the final message, the changed files and the diff, not what
  the agent ran. The diff leaves out dependencies, build output (`dist/`, `.next/`, top-level
  `build/` and `out/`), lockfiles, `*.map`, `*.tsbuildinfo` and minified files. `state` picks
  what the judge is given (its state, not the workspace's), keyed by `judge-input.json`'s state fields:
  `{ state: { diff: ['src/', '!**/*.test.ts'] } }` (gitignore-style, last match wins) narrows the
  diff; `{ state: { contents: ['README.md', 'src/**'] } }` shows files whole, changed or not;
  `{ state: { transcript: 'tools' } }` adds the turn's tool calls; `{ state: { checks: ['npm test'] } }`
  adds that `c.exec` result; `turns: 'all'` gives every turn; `task: false` and `output: false`
  leave those out. `state` cascades like every other option, key by key. `artifacts`
  is call-only: `true` for every capture so far, or `c.capture()` handles or names, sent as file parts. Ask about facts in the
  picture, not whether it "looks great". Jev (`typesafe-ai/jev-1.14.0`) takes PNG captures; a
  provider that cannot take files fails that call.
  Prefer deterministic checks for what can be checked; use the judge for quality, with plain
  yes/no questions that don't name one specific way of doing it.
- Give the environment a `.gitignore` in `files` (the project's isn't copied in): an agent that
  runs a build otherwise fills the judge's diff with its output. reeval sends everything `state`
  selects, uncut, and knows no model's limit: a provider error keeps the provider's wording and
  adds one line with the input's estimated size, biggest files and the `state` keys that were on,
  largest first; narrow one, e.g. `state: { diff: ['src/'] }`.
- A failed judge call doesn't throw: `c.judge()` returns `{ verdict: 'error', score: null, error }`,
  the later judges and checks still run, and the attempt fails as a judge error at the end.
  Write `expect.soft(await c.judge(q), name).toPass()` to see every judge's result.

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
a read of the file trips it and a script's write slips past. When the behaviour is the
outcome, judge the program's output, not the diff:
`c.judge(q, { on: (await c.exec('node app.js')).stdout })`. Checks run in the agent's
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
  `toHaveFetched(url?)`. `.not` and `expect.soft` are Vitest's. `toHaveCalledSkill`
  is opened or loaded (a `skill` / `load_skill` tool, or a Read/`sed` of
  `skills/<name>/`), not "followed". MCP is `toHaveCalledMcp(server, tool)`
  (the names in `mcp.<server>`); `toHaveCalledTool('mcp__<server>__<tool>')` is
  the raw transcript name. After adapters and the normaliser, that string is
  the same on every harness (stdio; Goose, OpenCode, pi and Codex refuse
  `mcp.sse`). Use `toHaveEdited` / `toHaveSearched`, not
  `toHaveCalledTool('edit')` or `'webSearch'`.
- Guard files the agent must leave alone with `expect(c).not.toHaveChanged(['test/**',
  'package.json'])` (sync): it reads the workspace diff, so a shell or subprocess write counts
  and a read doesn't. Strings are globs (a directory matches everything under it), RegExps work,
  and a turn means up to that turn. `toHaveEdited` reads the transcript; don't use it as a guard.
- A failed `expect` the eval catches still fails the attempt, when the body ends, as
  `expect.soft` does; its error says the eval caught it. Wait or retry with `expect.poll`
  (`await expect.poll(() => c.exec(cmd), { timeout: 10_000 }).toSucceed()`), which records one
  check with its final outcome, not with `expect` in a `try` loop.
- **Label each requirement** with `expect`'s second argument:
  `await expect.soft(c, 'exports greet').toHaveFile('greet.js', /export/)`. Every matcher call
  is recorded (`evals[].attempts[].assertions`; unlabelled ones get `<matcher> <first arg>`).
  Changing a label changes the eval's fingerprint. Label judges too
  (`expect.soft(await c.judge(q), 'Social OAuth').toPass()`): the label replaces the clipped
  question in judge rates, `reeval show`, `summary.md` and the digest.
