# reeval run 20260929T034525Z_a7bf43a_runner_h50r

1 passed · started 2026-09-29T03:45:25.514Z (10s)

Plan: 1 evals · 1 cells · 1 attempts · budget 1 attempts

## State

| | |
|---|---|
| Executed at | a7bf43aa4ac4 on main, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.0 · id 117b7f5d33a3 · no registry digest (built locally) · CLI @cursor/sdk 1.0.32 |
| Harnesses | cursor:composer-2.5 (model composer-2.5, served composer-2.5[fast=false]) |
| Environments | none |
| Judge | none by default · threshold 0.8 · version 0e2a4839495b |
| Context | 1 file: ~/.agents/skills/.ai-sdk-harness-skills.json 5ddf48ce4d70 |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.0 · @reeval/harness-opencode 0.2.0 · @reeval/harness-goose 0.1.0 · @reeval/harness-pi 0.1.0 · @reeval/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @reeval/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| reeval | 0.0.1 · node 24.21.0 · linux/x64 |
| Runner | local · runner |

> **Warning:** Image reeval-sandbox:cursor-0.1.0 isn't pushed, so an exact rerun needs this machine's image (id 117b7f5d33a3).

Record: [20260929T034525Z_a7bf43a_runner_h50r.json](../20260929T034525Z_a7bf43a_runner_h50r.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✓ | evals/hello.eval.ts › writes hello | 9s |  |

### ✓ evals/hello.eval.ts › writes hello

- Prompt (completed, 6s): Create a file named hello.txt whose only content is `hello from es`, then stop.
- Time: setup 3s · agent 6s · checks 0ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 94ms reasoning
- Changed: added `hello.txt`

Last message:

> Created `hello.txt` with the content `hello from es`.

- Files: [transcript](evals-hello-eval-ts-writes-hello-98d896/cursor-composer-2-5-docker-76739b/1/transcript.jsonl) · [diff](evals-hello-eval-ts-writes-hello-98d896/cursor-composer-2-5-docker-76739b/1/diff.patch)
