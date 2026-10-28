# reeval run 20261028T144604Z_nogit_cursor-agent_6bgc

2 pass · started 2026-10-28T14:46:04.780Z (2s)

Plan: 2 evals · 2 cells · 2 attempts

## Results

```text
pass             serves on PORT
pass             serves on its own port

2 pass
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | servers 1ef26df59216 |
| Judge | none by default · threshold 0.8 · version 717433497d3f |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.12 · @reeval/harness-opencode 0.2.10 · @reeval/harness-goose 0.1.6 · @reeval/harness-pi 0.2.8 · @reeval/harness-cursor-sdk 0.1.6 · @ai-sdk/harness-claude-code 1.0.160-patch.b17cde50 · @reeval/harness-codex 0.1.9 · @reeval/harness-fx 0.1.3 · @reeval/harness-grok-build 0.1.6 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/anthropic 4.0.83 · @ai-sdk/google 4.0.100 · @ai-sdk/openai 4.0.97 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.15.1 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261028T144604Z_nogit_cursor-agent_6bgc.json](../20261028T144604Z_nogit_cursor-agent_6bgc.json) · artifacts: all

## Attempts

### ✓ evals/serve.eval.ts › serves on PORT

- Time: setup 22ms · agent 0ms · checks 10ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `curl -s 127.0.0.1:43027` ([log](evals-serve-eval-ts-serves-on-port-24ce2a/fake-servers-fake-87e09b/1/checks/1.log))

### ✓ evals/serve.eval.ts › serves on its own port

- Time: setup 21ms · agent 0ms · checks 10ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `curl -s -g '[::1]:35675'` ([log](evals-serve-eval-ts-serves-on-its-own-port-19dcc6/fake-servers-fake-87e09b/1/checks/1.log))
