# reeval run 20261027T093027Z_nogit_cursor-agent_sapx

1 fail · 2 pass · started 2026-10-27T09:30:27.092Z (785ms)

Plan: 3 evals · 3 cells · 11 attempts

## Results

```text
pass             agrees

pass             splits
  3 tries          2 of 3
  toBe 1           2 of 3
    expected +0 to be 1 // Object.is equality

fail             fails twice
  4 tries          1 of 4 · 1 not needed (best of 5)
  toBe 1           1 of 4
    expected +0 to be 1 // Object.is equality

1 fail · 2 pass
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | none |
| Judge | none by default · threshold 0.8 · version 7390a72b715f |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.12 · @reeval/harness-opencode 0.2.10 · @reeval/harness-goose 0.1.6 · @reeval/harness-pi 0.2.8 · @reeval/harness-cursor-sdk 0.1.6 · @ai-sdk/harness-claude-code 1.0.160-patch.b17cde50 · @reeval/harness-codex 0.1.9 · @reeval/harness-fx 0.1.1 · @reeval/harness-grok-build 0.1.5 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/anthropic 4.0.83 · @ai-sdk/google 4.0.100 · @ai-sdk/openai 4.0.97 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.14.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261027T093027Z_nogit_cursor-agent_sapx.json](../20261027T093027Z_nogit_cursor-agent_sapx.json) · artifacts: all

## Attempts

### ✗ bo.eval.ts › fails twice

#### ✗ fake/-/fake#1

**assertion**

```
expected +0 to be 1 // Object.is equality
```

- Prompt (completed, 0ms): hi
- Time: setup 17ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-fails-twice-40f2c2/fake-fake-70e87d/1/transcript.jsonl) · [diff](bo-eval-ts-fails-twice-40f2c2/fake-fake-70e87d/1/diff.patch)
#### ✗ fake/-/fake#3

**assertion**

```
expected +0 to be 1 // Object.is equality
```

- Prompt (completed, 0ms): hi
- Time: setup 20ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-fails-twice-40f2c2/fake-fake-70e87d/3/transcript.jsonl) · [diff](bo-eval-ts-fails-twice-40f2c2/fake-fake-70e87d/3/diff.patch)
#### ✗ fake/-/fake#4

**assertion**

```
expected +0 to be 1 // Object.is equality
```

- Prompt (completed, 0ms): hi
- Time: setup 12ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-fails-twice-40f2c2/fake-fake-70e87d/4/transcript.jsonl) · [diff](bo-eval-ts-fails-twice-40f2c2/fake-fake-70e87d/4/diff.patch)
#### ✓ fake/-/fake#2

- Prompt (completed, 0ms): hi
- Time: setup 22ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-fails-twice-40f2c2/fake-fake-70e87d/2/transcript.jsonl) · [diff](bo-eval-ts-fails-twice-40f2c2/fake-fake-70e87d/2/diff.patch)

### ✓ bo.eval.ts › agrees

#### ✓ fake/-/fake#1

- Prompt (completed, 1ms): hi
- Time: setup 23ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-agrees-39efc8/fake-fake-70e87d/1/transcript.jsonl) · [diff](bo-eval-ts-agrees-39efc8/fake-fake-70e87d/1/diff.patch)
#### ✓ fake/-/fake#2

- Prompt (completed, 0ms): hi
- Time: setup 22ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-agrees-39efc8/fake-fake-70e87d/2/transcript.jsonl) · [diff](bo-eval-ts-agrees-39efc8/fake-fake-70e87d/2/diff.patch)

### ✓ bo.eval.ts › splits

#### ✗ fake/-/fake#2

**assertion**

```
expected +0 to be 1 // Object.is equality
```

- Prompt (completed, 0ms): hi
- Time: setup 23ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-splits-5310c2/fake-fake-70e87d/2/transcript.jsonl) · [diff](bo-eval-ts-splits-5310c2/fake-fake-70e87d/2/diff.patch)
#### ✓ fake/-/fake#1

- Prompt (completed, 0ms): hi
- Time: setup 33ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-splits-5310c2/fake-fake-70e87d/1/transcript.jsonl) · [diff](bo-eval-ts-splits-5310c2/fake-fake-70e87d/1/diff.patch)
#### ✓ fake/-/fake#3

- Prompt (completed, 0ms): hi
- Time: setup 13ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> ok

- Files: [transcript](bo-eval-ts-splits-5310c2/fake-fake-70e87d/3/transcript.jsonl) · [diff](bo-eval-ts-splits-5310c2/fake-fake-70e87d/3/diff.patch)
