# reeval run 20261103T142526Z_nogit_cursor-agent_xk93

1 pass · started 2026-11-03T14:25:26.103Z (3s)

Plan: 1 evals · 1 cells · 1 attempts

## Results

```text
pass             listed

1 pass
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.8 · id c169305ee210 · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | fake |
| Environments | listed 794bf4ed3042 |
| Judge | none by default · threshold 0.8 · version 4ad59c27538d |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.13 · @reeval/harness-opencode 0.2.16 · @reeval/harness-goose 0.1.12 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.8 · @ai-sdk/harness-claude-code 1.0.176-patch.8c0f3055 · @reeval/harness-codex 0.1.10 · @reeval/harness-fx 0.1.7 · @reeval/harness-grok-build 0.1.10 · ai 7.0.161 · @ai-sdk/harness 1.0.172 · @ai-sdk/anthropic 4.0.95 · @ai-sdk/google 4.0.110 · @ai-sdk/openai 4.0.107 · @ai-sdk/typesafe-ai 3.0.32 |
| reeval | 0.20.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.8 isn't pushed, so an exact rerun needs this machine's image (id c169305ee210).

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261103T142526Z_nogit_cursor-agent_xk93.json](../20261103T142526Z_nogit_cursor-agent_xk93.json) · artifacts: all

## Attempts

### ✓ evals/listed.eval.ts › listed

- Prompt (completed, 142ms): reach both hosts
- Time: setup 2s · agent 140ms · checks 0ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 2 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [setup log](evals-listed-eval-ts-listed-241a9d/fake-listed-docker-b8667d/1/setup.log) · [transcript](evals-listed-eval-ts-listed-241a9d/fake-listed-docker-b8667d/1/transcript.jsonl) · [diff](evals-listed-eval-ts-listed-241a9d/fake-listed-docker-b8667d/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-listed-eval-ts-listed-241a9d/fake-listed-docker-b8667d/1/snapshots/final)
