# reeval run 20261109T203553Z_0bbae45_cursor-agent_z4pz

1 pass · started 2026-11-09T20:35:53.597Z (4s)

Plan: 1 evals · 1 cells · 1 attempts

## Results

```text
pass             sends the key off its host

1 pass
```

## State

| | |
|---|---|
| Executed at | 0bbae4503f73 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.9 · id 89e5dcb843c3 · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | fake |
| Resources | docker 2 vCPU 4.0 GiB: 1 attempt · CPU 0.1 s (avg 0.24, peak 0.24 cores) · memory peak 22 MiB |
| Environments | keys c69a1959a772 · secrets API_KEY |
| Judge | none by default · threshold 0.8 · version ad7a34e4636f |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.16 · @reeval/harness-opencode 0.2.16 · @reeval/harness-goose 0.1.16 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.9 · @ai-sdk/harness-claude-code 1.0.176-patch.a9d56a8c · @reeval/harness-codex 0.1.13 · @reeval/harness-fx 0.1.11 · @reeval/harness-grok-build 0.1.12 · ai 7.0.161 · @ai-sdk/harness 1.0.172 · @ai-sdk/anthropic 4.0.95 · @ai-sdk/google 4.0.110 · @ai-sdk/openai 4.0.107 · @ai-sdk/typesafe-ai 3.0.32 |
| reeval | 0.23.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.9 isn't pushed, so an exact rerun needs this machine's image (id 89e5dcb843c3).

Record: [20261109T203553Z_0bbae45_cursor-agent_z4pz.json](../20261109T203553Z_0bbae45_cursor-agent_z4pz.json) · artifacts: all

## Attempts

### ✓ evals/sends.eval.ts › sends the key off its host

- Prompt (completed, 121ms): call example.com with the key
- Time: setup 2s · agent 119ms · checks 0ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-sends-eval-ts-sends-the-key-off-its-host-7fc63b/fake-keys-docker-a10e17/1/transcript.jsonl) · [diff](evals-sends-eval-ts-sends-the-key-off-its-host-7fc63b/fake-keys-docker-a10e17/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-sends-eval-ts-sends-the-key-off-its-host-7fc63b/fake-keys-docker-a10e17/1/snapshots/final)
