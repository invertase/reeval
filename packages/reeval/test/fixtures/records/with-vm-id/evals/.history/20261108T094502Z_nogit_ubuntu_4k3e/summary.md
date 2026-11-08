# reeval run 20261108T094502Z_nogit_ubuntu_4k3e

1 fail · 1 pass · started 2026-11-08T09:45:02.111Z (8s)

Plan: 2 evals · 2 cells · 2 attempts

## Results

```text
fail             canary
  toBe 0           failed  evals/canary.eval.ts:6
    expected 4 to be +0 // Object.is equality
  snapshot         .reeval/runs/20261108T094502Z_nogit_ubuntu_4k3e/evals-canary-eval-ts-canary-d06886/fake-vm-daytona-8ae316/1/snapshots/final

pass             lands

1 fail · 1 pass
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Resources | daytona medium 4 vCPU 15.6 GiB: 2 attempts · CPU 21.4 s (avg 3.32, peak 3.84 cores) · memory peak 12.3 GiB |
| Environments | vm c689fe3f6893 |
| Judge | none by default · threshold 0.8 · version 2443ca66db9b |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.16 · @reeval/harness-opencode 0.2.16 · @reeval/harness-goose 0.1.16 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.9 · @ai-sdk/harness-claude-code 1.0.176-patch.a9d56a8c · @reeval/harness-codex 0.1.13 · @reeval/harness-fx 0.1.11 · @reeval/harness-grok-build 0.1.12 · ai 7.0.161 · @ai-sdk/harness 1.0.172 · @ai-sdk/anthropic 4.0.95 · @ai-sdk/google 4.0.110 · @ai-sdk/openai 4.0.107 · @ai-sdk/typesafe-ai 3.0.32 |
| reeval | 0.22.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · ubuntu |

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261108T094502Z_nogit_ubuntu_4k3e.json](../20261108T094502Z_nogit_ubuntu_4k3e.json) · artifacts: all

## Attempts

### ✗ evals/canary.eval.ts › canary

**assertion**

```
expected 4 to be +0 // Object.is equality
```

- Time: setup 2s · agent 0ms · checks 3s · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · reasoning time not reported
- Check exit 0: `node -e 'const t = Date.now(); while (Date.now() - t < 3000);…` ([log](evals-canary-eval-ts-canary-d06886/fake-vm-daytona-8ae316/1/checks/1.log))
- Snapshots (in .reeval/runs, never recorded): [final](evals-canary-eval-ts-canary-d06886/fake-vm-daytona-8ae316/1/snapshots/final)

### ✓ evals/lands.eval.ts › lands

- Time: setup 2s · agent 0ms · checks 3s · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · reasoning time not reported
- Check exit 0: `node -e 'const t = Date.now(); while (Date.now() - t < 3000);…` ([log](evals-lands-eval-ts-lands-2fc777/fake-vm-daytona-8ae316/1/checks/1.log))
- Snapshots (in .reeval/runs, never recorded): [final](evals-lands-eval-ts-lands-2fc777/fake-vm-daytona-8ae316/1/snapshots/final)
