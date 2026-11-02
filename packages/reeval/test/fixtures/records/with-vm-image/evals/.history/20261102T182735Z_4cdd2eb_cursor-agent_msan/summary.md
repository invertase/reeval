# reeval run 20261102T182735Z_4cdd2eb_cursor-agent_msan

1 pass · started 2026-11-02T18:27:35.742Z (864ms)

Plan: 1 evals · 1 cells · 1 attempts

## Results

```text
pass             works in a macOS VM

1 pass
```

## State

| | |
|---|---|
| Executed at | 4cdd2eb5df2a on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | none |
| Judge | none by default · threshold 0.8 · version 991ce2915785 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.13 · @reeval/harness-opencode 0.2.13 · @reeval/harness-goose 0.1.10 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.8 · @ai-sdk/harness-claude-code 1.0.171-patch.8cc1b324 · @reeval/harness-codex 0.1.10 · @reeval/harness-fx 0.1.5 · @reeval/harness-grok-build 0.1.8 · ai 7.0.156 · @ai-sdk/harness 1.0.167 · @ai-sdk/anthropic 4.0.91 · @ai-sdk/google 4.0.107 · @ai-sdk/openai 4.0.104 · @ai-sdk/typesafe-ai 3.0.29 |
| reeval | 0.18.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

Record: [20261102T182735Z_4cdd2eb_cursor-agent_msan.json](../20261102T182735Z_4cdd2eb_cursor-agent_msan.json) · artifacts: all

## Attempts

### ✓ evals/vm.eval.ts › works in a macOS VM

- Prompt (completed, 0ms): Say hello
- Time: setup 109ms · agent 0ms · checks 7ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `printf hello > hello.txt && cat hello.txt` ([log](evals-vm-eval-ts-works-in-a-macos-vm-92d8e0/fake-tart-macos-sequoia-base-15-6-8c94ed/1/checks/1.log))

Last message:

> Done.

- Files: [transcript](evals-vm-eval-ts-works-in-a-macos-vm-92d8e0/fake-tart-macos-sequoia-base-15-6-8c94ed/1/transcript.jsonl) · [diff](evals-vm-eval-ts-works-in-a-macos-vm-92d8e0/fake-tart-macos-sequoia-base-15-6-8c94ed/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-vm-eval-ts-works-in-a-macos-vm-92d8e0/fake-tart-macos-sequoia-base-15-6-8c94ed/1/snapshots/final)
