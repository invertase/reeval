# reeval run 20261021T182700Z_c165378_cursor-agent_nryn

1 fail · 1 pass · started 2026-10-21T18:27:00.048Z (28s)

Plan: 2 evals · 3 cells · 7 attempts

## Results

```text
fail             lands heads on the first try
  No: only 1 of 3 passed "lands heads".
  3 tries          1 of 3
  lands heads      1 of 3
    expected 2 to be 1 // Object.is equality

pass             uses the marker with the marked skill
  Yes: every try passed.
  arm              pass
  plain            0 of 2
    Only 0 of 2 passed "uses the marker".
  marked           2 of 2  can't tell yet
  check            plain   marked
  uses the marker  0 of 2  2 of 2
    expected false to be true // Object.is equality

1 fail; start with "lands heads on the first try".
1 fail · 1 pass
```

## State

| | |
|---|---|
| Executed at | c165378bbd2e on master, dirty (the commit that adds this record is later) |
| Uncommitted | worktree.patch, 77 bytes, sha256 bf0e0642aba3 |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.5 · id ace1c49a9c90 · no registry digest (built locally) · CLI @cursor/sdk 1.0.38 |
| Harnesses | fake |
| Environments | fake eca09e8f139f; marked d14dce4280d6; plain eca09e8f139f |
| Judge | none by default · threshold 0.8 · version 232cbb65edee |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.8 · @reeval/harness-opencode 0.2.8 · @reeval/harness-goose 0.1.3 · @reeval/harness-pi 0.2.7 · @reeval/harness-cursor-sdk 0.1.5 · @ai-sdk/harness-claude-code 1.0.160-patch.b17cde50 · @reeval/harness-codex 0.1.7 · @reeval/harness-fx 0.1.0 · @reeval/harness-grok-build 0.1.1 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/google 4.0.100 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.11.0 · node 22.23.3 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.5 isn't pushed, so an exact rerun needs this machine's image (id ace1c49a9c90).

Record: [20261021T182700Z_c165378_cursor-agent_nryn.json](../20261021T182700Z_c165378_cursor-agent_nryn.json) · artifacts: all

## Attempts

### ✗ evals/coin.eval.ts › lands heads on the first try

#### ✗ fake/fake/fake#2

**assertion**

```
lands heads: expected 2 to be 1 // Object.is equality
```

- Prompt (completed, 0ms): flip the coin
- Time: setup 30ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-coin-eval-ts-lands-heads-on-the-first-try-c55226/fake-fake-fake-dc13e2/2/transcript.jsonl) · [diff](evals-coin-eval-ts-lands-heads-on-the-first-try-c55226/fake-fake-fake-dc13e2/2/diff.patch)
#### ✗ fake/fake/fake#3

**assertion**

```
lands heads: expected 3 to be 1 // Object.is equality
```

- Prompt (completed, 0ms): flip the coin
- Time: setup 13ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-coin-eval-ts-lands-heads-on-the-first-try-c55226/fake-fake-fake-dc13e2/3/transcript.jsonl) · [diff](evals-coin-eval-ts-lands-heads-on-the-first-try-c55226/fake-fake-fake-dc13e2/3/diff.patch)
#### ✓ fake/fake/fake#1

- Prompt (completed, 1ms): flip the coin
- Time: setup 36ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-coin-eval-ts-lands-heads-on-the-first-try-c55226/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-coin-eval-ts-lands-heads-on-the-first-try-c55226/fake-fake-fake-dc13e2/1/diff.patch)

### ✓ evals/skill.eval.ts › uses the marker with the marked skill

#### ✓ fake/marked/docker#1

- Prompt (completed, 0ms): go
- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-skill-eval-ts-uses-the-marker-with-the-marked-skill-15829a/fake-marked-docker-71e93f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-uses-the-marker-with-the-marked-skill-15829a/fake-marked-docker-71e93f/1/diff.patch)
#### ✓ fake/marked/docker#2

- Prompt (completed, 0ms): go
- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-skill-eval-ts-uses-the-marker-with-the-marked-skill-15829a/fake-marked-docker-71e93f/2/transcript.jsonl) · [diff](evals-skill-eval-ts-uses-the-marker-with-the-marked-skill-15829a/fake-marked-docker-71e93f/2/diff.patch)
#### ○ fake/plain/docker#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
uses the marker: expected false to be true // Object.is equality
```

- Prompt (completed, 1ms): go
- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-skill-eval-ts-uses-the-marker-with-the-marked-skill-15829a/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-uses-the-marker-with-the-marked-skill-15829a/fake-plain-docker-98d88a/1/diff.patch)

</details>
#### ○ fake/plain/docker#2 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
uses the marker: expected false to be true // Object.is equality
```

- Prompt (completed, 0ms): go
- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-skill-eval-ts-uses-the-marker-with-the-marked-skill-15829a/fake-plain-docker-98d88a/2/transcript.jsonl) · [diff](evals-skill-eval-ts-uses-the-marker-with-the-marked-skill-15829a/fake-plain-docker-98d88a/2/diff.patch)

</details>
