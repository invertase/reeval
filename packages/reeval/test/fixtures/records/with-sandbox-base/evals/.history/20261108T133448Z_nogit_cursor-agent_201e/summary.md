# reeval run 20261108T133448Z_nogit_cursor-agent_201e

2 pass · started 2026-11-08T13:34:48.098Z (15s)

Plan: 2 evals · 2 cells · 2 attempts

## Results

```text
pass             canary
pass             lands

2 pass
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Resources | boat small 4 vCPU 15.6 GiB: 2 attempts · CPU 0.2 s (avg 0.22, peak 0.22 cores) · memory peak 27 MiB |
| Environments | closed 62b9fdc93469; open c689fe3f6893 |
| Judge | none by default · threshold 0.8 · version 2443ca66db9b |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.16 · @reeval/harness-opencode 0.2.16 · @reeval/harness-goose 0.1.16 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.9 · @ai-sdk/harness-claude-code 1.0.176-patch.a9d56a8c · @reeval/harness-codex 0.1.13 · @reeval/harness-fx 0.1.11 · @reeval/harness-grok-build 0.1.12 · ai 7.0.161 · @ai-sdk/harness 1.0.172 · @ai-sdk/anthropic 4.0.95 · @ai-sdk/google 4.0.110 · @ai-sdk/openai 4.0.107 · @ai-sdk/typesafe-ai 3.0.32 |
| reeval | 0.22.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261108T133448Z_nogit_cursor-agent_201e.json](../20261108T133448Z_nogit_cursor-agent_201e.json) · artifacts: failures

## Attempts

### ✓ evals/canary.eval.ts › canary

- Prompt (completed, 90ms): reach the listener
- Time: setup 4s · agent 88ms · checks 0ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Snapshots (in .reeval/runs, never recorded): [final](evals-canary-eval-ts-canary-d06886/fake-open-boat-68c24521-92f4d2/1/snapshots/final)

### ✓ evals/lands.eval.ts › lands

- Prompt (completed, 104ms): where am I
- Time: setup 4s · agent 102ms · checks 0ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Snapshots (in .reeval/runs, never recorded): [final](evals-lands-eval-ts-lands-2fc777/fake-closed-boat-68c24521-61a210/1/snapshots/final)
