# reeval run 20261101T084156Z_0ce3c84_cursor-agent_3c65

2 fail · 8 pass · 2 ran · started 2026-11-01T08:41:56.054Z (1s)

Plan: 13 evals · 16 cells · 18 attempts

## Results

```text
                 rated
        a            1 of 1
        b            1 of 1
        c            0 of 1
    passes its case  failed  evals/cases.eval.ts:14
      expected 'c' not to be 'c' // Object.is equality
    snapshot         .reeval/runs/20261101T084156Z_0ce3c84_cursor-agent_3c65/evals-cases-eval-ts-rated-c-3922df/fake-fake-fake-dc13e2/1/snapshots/final
  pass  all cases    2 of 3  pass@1 67%, passRate 0.6

                 strict
  pass  x            2 of 2
  fail  y            0 of 2
    passes its case  0 of 2  evals/cases.eval.ts:20
      expected 'y' to be 'x' // Object.is equality
    snapshot         .reeval/runs/20261101T084156Z_0ce3c84_cursor-agent_3c65/evals-cases-eval-ts-strict-y-ad030a/fake-fake-fake-dc13e2/1/snapshots/final (+1 more in summary.md)

                 lands
  pass  next
    arm            pass
    next-app       1 of 1
  pass  vite
    arm            pass
    vite-app       1 of 1

                 lifted
  pass  Ada
    arm            pass
    plain          0 of 1
    with-skill     1 of 1
  pass  Grace
    arm            pass
    plain          0 of 1
    with-skill     1 of 1
  pass  Linus
    arm            pass
    plain          0 of 1
    with-skill     1 of 1
  fail  all cases
    arm            pass
    plain          0 of 3
    with-skill     3 of 3  can't tell yet, not by minLift 50

pass             alone [only]

                 picks
  ran  p1          1 of 1
  ran  p2          1 of 1

2 fail · 8 pass · 2 ran
```

## State

| | |
|---|---|
| Executed at | 0ce3c84c12a9 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | fake eca09e8f139f; next-app 39d20a9bc50f; plain eca09e8f139f; vite-app f1698ffe2837; with-skill e4cf82b6720e |
| Judge | none by default · threshold 0.8 · version 1c314a6e4c08 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.13 · @reeval/harness-opencode 0.2.13 · @reeval/harness-goose 0.1.10 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.8 · @ai-sdk/harness-claude-code 1.0.171-patch.8cc1b324 · @reeval/harness-codex 0.1.10 · @reeval/harness-fx 0.1.5 · @reeval/harness-grok-build 0.1.8 · ai 7.0.156 · @ai-sdk/harness 1.0.167 · @ai-sdk/anthropic 4.0.91 · @ai-sdk/google 4.0.107 · @ai-sdk/openai 4.0.104 · @ai-sdk/typesafe-ai 3.0.29 |
| reeval | 0.17.2 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

Record: [20261101T084156Z_0ce3c84_cursor-agent_3c65.json](../20261101T084156Z_0ce3c84_cursor-agent_3c65.json) · artifacts: all

## Attempts

### ✗ evals/cases.eval.ts › rated [c]

**assertion**

```
passes its case: expected 'c' not to be 'c' // Object.is equality
```

- Prompt (completed, 6ms): Greet c.
- Time: setup 23ms · agent 6ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-rated-c-3922df/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-rated-c-3922df/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-rated-c-3922df/fake-fake-fake-dc13e2/1/snapshots/final)

### ✗ evals/cases.eval.ts › strict [y]

#### ✗ fake/fake/fake#1

**assertion**

```
passes its case: expected 'y' to be 'x' // Object.is equality
```

- Prompt (completed, 1ms): Greet y.
- Time: setup 14ms · agent 1ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-strict-y-ad030a/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-strict-y-ad030a/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-strict-y-ad030a/fake-fake-fake-dc13e2/1/snapshots/final)
#### ✗ fake/fake/fake#2

**assertion**

```
passes its case: expected 'y' to be 'x' // Object.is equality
```

- Prompt (completed, 6ms): Greet y.
- Time: setup 10ms · agent 6ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-strict-y-ad030a/fake-fake-fake-dc13e2/2/transcript.jsonl) · [diff](evals-cases-eval-ts-strict-y-ad030a/fake-fake-fake-dc13e2/2/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-strict-y-ad030a/fake-fake-fake-dc13e2/2/snapshots/final)

### ✓ evals/cases.eval.ts › rated [a]

- Prompt (completed, 4ms): Greet a.
- Time: setup 25ms · agent 3ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-rated-a-abff7a/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-rated-a-abff7a/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-rated-a-abff7a/fake-fake-fake-dc13e2/1/snapshots/final)

### ✓ evals/cases.eval.ts › rated [b]

- Prompt (completed, 4ms): Greet b.
- Time: setup 24ms · agent 4ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-rated-b-bb88b3/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-rated-b-bb88b3/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-rated-b-bb88b3/fake-fake-fake-dc13e2/1/snapshots/final)

### ✓ evals/cases.eval.ts › strict [x]

#### ✓ fake/fake/fake#1

- Prompt (completed, 24ms): Greet x.
- Time: setup 27ms · agent 25ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-strict-x-6c40d5/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-strict-x-6c40d5/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-strict-x-6c40d5/fake-fake-fake-dc13e2/1/snapshots/final)
#### ✓ fake/fake/fake#2

- Prompt (completed, 0ms): Greet x.
- Time: setup 12ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-strict-x-6c40d5/fake-fake-fake-dc13e2/2/transcript.jsonl) · [diff](evals-cases-eval-ts-strict-x-6c40d5/fake-fake-fake-dc13e2/2/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-strict-x-6c40d5/fake-fake-fake-dc13e2/2/snapshots/final)

### ✓ evals/cases.eval.ts › lands [next]

- Time: setup 16ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits (edit tool calls) · 0 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · reasoning time not reported
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-lands-next-ada082/fake-next-app-fake-23258a/1/snapshots/final)

### ✓ evals/cases.eval.ts › lands [vite]

- Time: setup 17ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits (edit tool calls) · 0 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · reasoning time not reported
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-lands-vite-e54e84/fake-vite-app-fake-f801b9/1/snapshots/final)

### ✓ evals/cases.eval.ts › lifted [Ada]

#### ✓ fake/with-skill/fake#1

- Prompt (completed, 4ms): Greet Ada.
- Time: setup 19ms · agent 4ms · checks 4ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check has the skill exit 0: `test -f skill.txt` ([log](evals-cases-eval-ts-lifted-ada-39ad15/fake-with-skill-fake-14b6ac/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-lifted-ada-39ad15/fake-with-skill-fake-14b6ac/1/transcript.jsonl) · [diff](evals-cases-eval-ts-lifted-ada-39ad15/fake-with-skill-fake-14b6ac/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-lifted-ada-39ad15/fake-with-skill-fake-14b6ac/1/snapshots/final)
#### ○ fake/plain/fake#1 · 1 check failed

<details><summary>Why it missed</summary>

**assertion**

```
has the skill: expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 1ms): Greet Ada.
- Time: setup 18ms · agent 1ms · checks 2ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check has the skill exit 1: `test -f skill.txt` ([log](evals-cases-eval-ts-lifted-ada-39ad15/fake-plain-fake-57f9db/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-lifted-ada-39ad15/fake-plain-fake-57f9db/1/transcript.jsonl) · [diff](evals-cases-eval-ts-lifted-ada-39ad15/fake-plain-fake-57f9db/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-lifted-ada-39ad15/fake-plain-fake-57f9db/1/snapshots/final)

</details>

### ✓ evals/cases.eval.ts › lifted [Grace]

#### ✓ fake/with-skill/fake#1

- Prompt (completed, 5ms): Greet Grace.
- Time: setup 15ms · agent 5ms · checks 6ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check has the skill exit 0: `test -f skill.txt` ([log](evals-cases-eval-ts-lifted-grace-7415c1/fake-with-skill-fake-14b6ac/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-lifted-grace-7415c1/fake-with-skill-fake-14b6ac/1/transcript.jsonl) · [diff](evals-cases-eval-ts-lifted-grace-7415c1/fake-with-skill-fake-14b6ac/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-lifted-grace-7415c1/fake-with-skill-fake-14b6ac/1/snapshots/final)
#### ○ fake/plain/fake#1 · 1 check failed

<details><summary>Why it missed</summary>

**assertion**

```
has the skill: expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 1ms): Greet Grace.
- Time: setup 12ms · agent 0ms · checks 7ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check has the skill exit 1: `test -f skill.txt` ([log](evals-cases-eval-ts-lifted-grace-7415c1/fake-plain-fake-57f9db/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-lifted-grace-7415c1/fake-plain-fake-57f9db/1/transcript.jsonl) · [diff](evals-cases-eval-ts-lifted-grace-7415c1/fake-plain-fake-57f9db/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-lifted-grace-7415c1/fake-plain-fake-57f9db/1/snapshots/final)

</details>

### ✓ evals/cases.eval.ts › lifted [Linus]

#### ✓ fake/with-skill/fake#1

- Prompt (completed, 5ms): Greet Linus.
- Time: setup 26ms · agent 5ms · checks 6ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check has the skill exit 0: `test -f skill.txt` ([log](evals-cases-eval-ts-lifted-linus-6dcc1e/fake-with-skill-fake-14b6ac/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-lifted-linus-6dcc1e/fake-with-skill-fake-14b6ac/1/transcript.jsonl) · [diff](evals-cases-eval-ts-lifted-linus-6dcc1e/fake-with-skill-fake-14b6ac/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-lifted-linus-6dcc1e/fake-with-skill-fake-14b6ac/1/snapshots/final)
#### ○ fake/plain/fake#1 · 1 check failed

<details><summary>Why it missed</summary>

**assertion**

```
has the skill: expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 5ms): Greet Linus.
- Time: setup 15ms · agent 4ms · checks 10ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check has the skill exit 1: `test -f skill.txt` ([log](evals-cases-eval-ts-lifted-linus-6dcc1e/fake-plain-fake-57f9db/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-lifted-linus-6dcc1e/fake-plain-fake-57f9db/1/transcript.jsonl) · [diff](evals-cases-eval-ts-lifted-linus-6dcc1e/fake-plain-fake-57f9db/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-lifted-linus-6dcc1e/fake-plain-fake-57f9db/1/snapshots/final)

</details>

### ✓ evals/cases.eval.ts › alone [only]

- Prompt (completed, 7ms): Greet only.
- Time: setup 25ms · agent 6ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-alone-only-36f851/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-alone-only-36f851/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-alone-only-36f851/fake-fake-fake-dc13e2/1/snapshots/final)

### ○ evals/cases.eval.ts › picks [p1] · ran

- Prompt (completed, 4ms): Pick for p1.
- Time: setup 18ms · agent 4ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Observed `pick`: `"drizzle"`
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-picks-p1-ceb45b/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-picks-p1-ceb45b/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-picks-p1-ceb45b/fake-fake-fake-dc13e2/1/snapshots/final)

### ○ evals/cases.eval.ts › picks [p2] · ran

- Prompt (completed, 1ms): Pick for p2.
- Time: setup 11ms · agent 1ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Observed `pick`: `"prisma"`
- Changed: added `greet.js`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-picks-p2-834bea/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-picks-p2-834bea/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-picks-p2-834bea/fake-fake-fake-dc13e2/1/snapshots/final)
