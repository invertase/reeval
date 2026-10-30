# reeval run 20261030T131206Z_nogit_cursor-agent_qb9s

1 pass · started 2026-10-30T13:12:06.188Z (733ms)

Plan: 1 evals · 1 cells · 1 attempts

## Results

```text
pass             a read the harness never finished

1 pass
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | fake eca09e8f139f |
| Judge | none by default · threshold 0.8 · version b7a490837586 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.12 · @reeval/harness-opencode 0.2.11 · @reeval/harness-goose 0.1.7 · @reeval/harness-pi 0.2.8 · @reeval/harness-cursor-sdk 0.1.6 · @ai-sdk/harness-claude-code 1.0.160-patch.b17cde50 · @reeval/harness-codex 0.1.9 · @reeval/harness-fx 0.1.3 · @reeval/harness-grok-build 0.1.6 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/anthropic 4.0.83 · @ai-sdk/google 4.0.100 · @ai-sdk/openai 4.0.97 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.17.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261030T131206Z_nogit_cursor-agent_qb9s.json](../20261030T131206Z_nogit_cursor-agent_qb9s.json) · artifacts: all

## Attempts

### ✓ evals/unfinished.eval.ts › a read the harness never finished

- Prompt (completed, 3ms): Uppercase beta in notes.txt
- Time: setup 28ms · agent 3ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 3 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `notes.txt`

Last message:

> Done.

- Files: [transcript](evals-unfinished-eval-ts-a-read-the-harness-never-finished-c64c66/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-unfinished-eval-ts-a-read-the-harness-never-finished-c64c66/fake-fake-fake-dc13e2/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-unfinished-eval-ts-a-read-the-harness-never-finished-c64c66/fake-fake-fake-dc13e2/1/snapshots/final)
