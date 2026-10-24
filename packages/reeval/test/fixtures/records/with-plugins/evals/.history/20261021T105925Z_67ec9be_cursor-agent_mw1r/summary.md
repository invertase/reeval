# reeval run 20261021T105925Z_67ec9be_cursor-agent_mw1r

1 pass · started 2026-10-21T10:59:25.383Z (756ms)

Plan: 1 evals · 1 cells · 1 attempts

## Results

```text
pass             places the plugin

1 pass
Set analysis.model in reeval.config.ts for answers to what each eval asks.
```

## State

| | |
|---|---|
| Executed at | 67ec9be0279e on master, dirty (the commit that adds this record is later) |
| Uncommitted | worktree.patch, 209 bytes, sha256 036992c5a143 |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | review 84e3a3e69397 · skills review-lint |
| Judge | none by default · threshold 0.8 · version 232cbb65edee |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.8 · @reeval/harness-opencode 0.2.8 · @reeval/harness-goose 0.1.3 · @reeval/harness-pi 0.2.7 · @reeval/harness-cursor-sdk 0.1.5 · @ai-sdk/harness-claude-code 1.0.160-patch.907f9184 · @reeval/harness-codex 0.1.7 · @reeval/harness-fx 0.1.0 · @reeval/harness-grok-build 0.1.0 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/google 4.0.100 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.11.0 · node 22.23.3 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

Record: [20261021T105925Z_67ec9be_cursor-agent_mw1r.json](../20261021T105925Z_67ec9be_cursor-agent_mw1r.json) · artifacts: all

## Attempts

### ✓ evals/review.eval.ts › places the plugin

- Time: setup 20ms · agent 0ms · checks 2ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `cat ~/.reeval/plugins/review/agents/reviewer.md` ([log](evals-review-eval-ts-places-the-plugin-b0e054/fake-review-fake-3e66f9/1/checks/1.log))
