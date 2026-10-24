# reeval run 20261024T152633Z_5c892a0_cursor-agent_qq46

1 pass · budget reached · started 2026-10-24T15:26:33.904Z (2s)

Plan: profile budget (--profile) · 1 evals · 1 cells · 4 attempts · budget 1s

## Results

```text
pass             takes its time

1 pass
```

## State

| | |
|---|---|
| Executed at | 5c892a06f26d on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | slow |
| Environments | fake eca09e8f139f |
| Judge | fake · threshold 0.8 · version 26284eecb750 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.12 · @reeval/harness-opencode 0.2.10 · @reeval/harness-goose 0.1.5 · @reeval/harness-pi 0.2.8 · @reeval/harness-cursor-sdk 0.1.6 · @ai-sdk/harness-claude-code 1.0.160-patch.b17cde50 · @reeval/harness-codex 0.1.8 · @reeval/harness-fx 0.1.1 · @reeval/harness-grok-build 0.1.4 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/anthropic 4.0.83 · @ai-sdk/google 4.0.100 · @ai-sdk/openai 4.0.97 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.13.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

Record: [20261024T152633Z_5c892a0_cursor-agent_qq46.json](../20261024T152633Z_5c892a0_cursor-agent_qq46.json) · artifacts: all

## Attempts

### ✓ evals/slow.eval.ts › takes its time

#### ✓ slow/fake/fake#1

- Prompt (completed, 404ms): Write greet.js slowly.
- Time: setup 19ms · agent 404ms · checks 18ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/diff.patch)
#### ✓ slow/fake/fake#2

- Prompt (completed, 402ms): Write greet.js slowly.
- Time: setup 12ms · agent 402ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/diff.patch)
#### ✓ slow/fake/fake#3

- Prompt (completed, 402ms): Write greet.js slowly.
- Time: setup 12ms · agent 402ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/diff.patch)
