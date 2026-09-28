# ES run 20260927T151935Z_facb81b_cursor-agent_07sv

1 passed · 1 skipped · started 2026-09-27T15:19:35.703Z (740ms)

Plan: 1 evals · 1 cells · 1 attempts

## State

| | |
|---|---|
| Executed at | facb81bea2e0 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | none |
| Judge | none by default · threshold 0.8 · version 0e2a4839495b |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | vitest 5.0.2 · @evalsuite/harness-antigravity 0.1.0 · @evalsuite/harness-opencode 0.1.0 · @evalsuite/harness-goose 0.1.0 · @evalsuite/harness-pi 0.1.0 · @evalsuite/harness-cursor-sdk 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/harness-claude-code 1.0.128 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| ES | 0.0.1 · node 22.14.0 · linux/x64 |
| Runner | local · cursor-agent |

Record: [20260927T151935Z_facb81b_cursor-agent_07sv.json](../20260927T151935Z_facb81b_cursor-agent_07sv.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✓ | evals/greet.es.ts › writes greet.js | 39ms |  |
| ↓ | evals/greet.es.ts › greets in French | 0ms |  |

### ✓ evals/greet.es.ts › writes greet.js

- Prompt (completed, 1ms): Write greet.js
- Time: setup 15ms · agent 1ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-greet-es-ts-writes-greet-js-4857ff/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-es-ts-writes-greet-js-4857ff/fake-fake-70e87d/1/diff.patch)
