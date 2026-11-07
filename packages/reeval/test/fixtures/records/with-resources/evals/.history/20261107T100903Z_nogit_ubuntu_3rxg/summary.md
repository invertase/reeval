# reeval run 20261107T100903Z_nogit_ubuntu_3rxg

1 fail · 1 pass · started 2026-11-07T10:09:03.035Z (6s)

Plan: 2 evals · 2 cells · 2 attempts

## Results

```text
fail             canary
  toBeGreaterThanOrEqual 2  failed  evals/canary.eval.ts:6
    expected 0 to be greater than or equal to 2
  snapshot                  .reeval/runs/20261107T100903Z_nogit_ubuntu_3rxg/evals-canary-eval-ts-canary-d06886/fake-busy-docker-bb19e8/1/snapshots/final

pass             lands

1 fail · 1 pass
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.9 · id 86cf61caff72 · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | fake |
| Resources | docker 1 vCPU 512 MiB: 2 attempts · CPU 3.3 s (avg 0.93, peak 1.00 cores) · memory peak 292 MiB |
| Environments | busy eca09e8f139f |
| Judge | none by default · threshold 0.8 · version a3ce9d328e88 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.16 · @reeval/harness-opencode 0.2.16 · @reeval/harness-goose 0.1.16 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.9 · @ai-sdk/harness-claude-code 1.0.176-patch.a9d56a8c · @reeval/harness-codex 0.1.13 · @reeval/harness-fx 0.1.11 · @reeval/harness-grok-build 0.1.12 · ai 7.0.161 · @ai-sdk/harness 1.0.172 · @ai-sdk/anthropic 4.0.95 · @ai-sdk/google 4.0.110 · @ai-sdk/openai 4.0.107 · @ai-sdk/typesafe-ai 3.0.32 |
| reeval | 0.21.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · ubuntu |

> **Warning:** Image reeval-sandbox:cursor-0.1.9 isn't pushed, so an exact rerun needs this machine's image (id 86cf61caff72).

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261107T100903Z_nogit_ubuntu_3rxg.json](../20261107T100903Z_nogit_ubuntu_3rxg.json) · artifacts: all

## Attempts

### ✗ evals/canary.eval.ts › canary

**assertion**

```
expected 0 to be greater than or equal to 2
```

- Time: setup 2s · agent 0ms · checks 80ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · reasoning time not reported
- Check exit 0: `echo $(( $(sed -n 's/^usage_usec //p' /sys/fs/cgroup/cpu.stat) / 1000000 ))` ([log](evals-canary-eval-ts-canary-d06886/fake-busy-docker-bb19e8/1/checks/1.log))
- Snapshots (in .reeval/runs, never recorded): [final](evals-canary-eval-ts-canary-d06886/fake-busy-docker-bb19e8/1/snapshots/final)

### ✓ evals/lands.eval.ts › lands

- Time: setup 2s · agent 0ms · checks 3s · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · reasoning time not reported
- Check exit 0: `node -e 'const b = Buffer.alloc(256 << 20, 1); const t = Date.now(); while…` ([log](evals-lands-eval-ts-lands-2fc777/fake-busy-docker-bb19e8/1/checks/1.log))
- Check exit 0: `echo $(( $(sed -n 's/^usage_usec //p' /sys/fs/cgroup/cpu.stat) / 1000000 ))` ([log](evals-lands-eval-ts-lands-2fc777/fake-busy-docker-bb19e8/1/checks/2.log))
- Snapshots (in .reeval/runs, never recorded): [final](evals-lands-eval-ts-lands-2fc777/fake-busy-docker-bb19e8/1/snapshots/final)
