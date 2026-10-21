# reeval run 20261021T130823Z_nogit_cursor-agent_kq9t

1 fail · 1 pass · started 2026-10-21T13:08:23.188Z (9s)

Plan: 2 evals · 3 cells · 7 attempts

## Results

```text
fail             coin
  3 tries          1 of 3
  lands heads      1 of 3
    expected 2 to be 1 // Object.is equality

pass             skill helps
  arm              pass
  docs             0 of 2
  marked           2 of 2  can't tell yet
  check            docs    marked
  uses the marker  0 of 2  2 of 2
    expected 'control' to be 'variant' // Object.is equality

1 fail · 1 pass
Set analysis.model in reeval.config.ts for answers to what each eval asks.

Remarks:
  coin: MCP server docs took 2s to start on each of 2 turns, in 3 of 3 tries.
    fix  evals/env.ts:9  install what docs needs in the image (install or dockerfile), so it doesn't fetch or build it at start-up
  skill helps: MCP server docs took 2s to start on each of 2 turns, in 4 of 4 tries.
    fix  evals/env.ts:9  install what docs needs in the image (install or dockerfile), so it doesn't fetch or build it at start-up
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | docs 6ceaca75e314 · mcp docs; marked 39308ac90d6b · mcp docs |
| Judge | none by default · threshold 0.8 · version 232cbb65edee |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.8 · @reeval/harness-opencode 0.2.8 · @reeval/harness-goose 0.1.3 · @reeval/harness-pi 0.2.7 · @reeval/harness-cursor-sdk 0.1.5 · @ai-sdk/harness-claude-code 1.0.160-patch.907f9184 · @reeval/harness-codex 0.1.7 · @reeval/harness-fx 0.1.0 · @reeval/harness-grok-build 0.1.0 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/google 4.0.100 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.11.0 · node 22.23.3 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261021T130823Z_nogit_cursor-agent_kq9t.json](../20261021T130823Z_nogit_cursor-agent_kq9t.json) · artifacts: all

## Attempts

### ✗ evals/coin.eval.ts › coin

#### ✗ fake/docs/fake#2

**assertion**

```
lands heads: expected 2 to be 1 // Object.is equality
```

- Prompt (completed, 2s): look it up
- Prompt (completed, 2s): and again
- Time: setup 38ms · agent 4s · checks 0ms · judge 0ms
- Agent: 0 file edits · 2 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> two

- Files: [transcript](evals-coin-eval-ts-coin-67040f/fake-docs-fake-45ef0f/2/transcript.jsonl) · [diff](evals-coin-eval-ts-coin-67040f/fake-docs-fake-45ef0f/2/diff.patch)
#### ✗ fake/docs/fake#3

**assertion**

```
lands heads: expected 3 to be 1 // Object.is equality
```

- Prompt (completed, 2s): look it up
- Prompt (completed, 2s): and again
- Time: setup 13ms · agent 4s · checks 0ms · judge 0ms
- Agent: 0 file edits · 2 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> two

- Files: [transcript](evals-coin-eval-ts-coin-67040f/fake-docs-fake-45ef0f/3/transcript.jsonl) · [diff](evals-coin-eval-ts-coin-67040f/fake-docs-fake-45ef0f/3/diff.patch)
#### ✓ fake/docs/fake#1

- Prompt (completed, 2s): look it up
- Prompt (completed, 2s): and again
- Time: setup 39ms · agent 4s · checks 0ms · judge 0ms
- Agent: 0 file edits · 2 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> two

- Files: [transcript](evals-coin-eval-ts-coin-67040f/fake-docs-fake-45ef0f/1/transcript.jsonl) · [diff](evals-coin-eval-ts-coin-67040f/fake-docs-fake-45ef0f/1/diff.patch)

### ✓ evals/skill.eval.ts › skill helps

#### ✓ fake/marked/fake#1

- Prompt (completed, 2s): look it up
- Prompt (completed, 2s): and again
- Time: setup 35ms · agent 4s · checks 0ms · judge 0ms
- Agent: 0 file edits · 2 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> two

- Files: [transcript](evals-skill-eval-ts-skill-helps-0c70ce/fake-marked-fake-3cce79/1/transcript.jsonl) · [diff](evals-skill-eval-ts-skill-helps-0c70ce/fake-marked-fake-3cce79/1/diff.patch)
#### ✓ fake/marked/fake#2

- Prompt (completed, 2s): look it up
- Prompt (completed, 2s): and again
- Time: setup 19ms · agent 4s · checks 0ms · judge 0ms
- Agent: 0 file edits · 2 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> two

- Files: [transcript](evals-skill-eval-ts-skill-helps-0c70ce/fake-marked-fake-3cce79/2/transcript.jsonl) · [diff](evals-skill-eval-ts-skill-helps-0c70ce/fake-marked-fake-3cce79/2/diff.patch)
#### ○ fake/docs/fake#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
uses the marker: expected 'control' to be 'variant' // Object.is equality
```

- Prompt (completed, 2s): look it up
- Prompt (completed, 2s): and again
- Time: setup 36ms · agent 4s · checks 0ms · judge 0ms
- Agent: 0 file edits · 2 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> two

- Files: [transcript](evals-skill-eval-ts-skill-helps-0c70ce/fake-docs-fake-45ef0f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-skill-helps-0c70ce/fake-docs-fake-45ef0f/1/diff.patch)

</details>
#### ○ fake/docs/fake#2 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
uses the marker: expected 'control' to be 'variant' // Object.is equality
```

- Prompt (completed, 2s): look it up
- Prompt (completed, 2s): and again
- Time: setup 18ms · agent 4s · checks 0ms · judge 0ms
- Agent: 0 file edits · 2 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> two

- Files: [transcript](evals-skill-eval-ts-skill-helps-0c70ce/fake-docs-fake-45ef0f/2/transcript.jsonl) · [diff](evals-skill-eval-ts-skill-helps-0c70ce/fake-docs-fake-45ef0f/2/diff.patch)

</details>
