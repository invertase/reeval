# reeval run 20261021T090857Z_a168dae_cursor-agent_g7v5

1 pass · budget reached · started 2026-10-21T09:08:57.064Z (2s)

Plan: profile budget (--profile) · 1 evals · 1 cells · 4 attempts · budget 1s

## Results

```text
pass             takes its time

1 pass
```

## State

| | |
|---|---|
| Executed at | a168daedb168 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | slow |
| Environments | fake eca09e8f139f |
| Judge | fake · threshold 0.8 · version 675f03c575e1 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.8 · @reeval/harness-opencode 0.2.8 · @reeval/harness-goose 0.1.3 · @reeval/harness-pi 0.2.7 · @reeval/harness-cursor-sdk 0.1.5 · @ai-sdk/harness-claude-code 1.0.160-patch.907f9184 · @reeval/harness-codex 0.1.7 · @reeval/harness-fx 0.1.0 · @reeval/harness-grok-build 0.1.0 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/google 4.0.100 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.11.0 · node 22.23.3 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

Record: [20261021T090857Z_a168dae_cursor-agent_g7v5.json](../20261021T090857Z_a168dae_cursor-agent_g7v5.json) · artifacts: all

## Attempts

### ✓ evals/slow.eval.ts › takes its time

#### ✓ slow/fake/fake#1

- Prompt (completed, 404ms): Write greet.js slowly.
- Time: setup 15ms · agent 404ms · checks 8ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/diff.patch)
#### ✓ slow/fake/fake#2

- Prompt (completed, 404ms): Write greet.js slowly.
- Time: setup 9ms · agent 403ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/diff.patch)
#### ✓ slow/fake/fake#3

- Prompt (completed, 402ms): Write greet.js slowly.
- Time: setup 9ms · agent 403ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/diff.patch)
