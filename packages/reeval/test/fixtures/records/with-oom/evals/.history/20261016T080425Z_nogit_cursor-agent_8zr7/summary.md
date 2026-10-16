# reeval run 20261016T080425Z_nogit_cursor-agent_8zr7

1 infra error · started 2026-10-16T08:04:25.191Z (3s)

Plan: 1 evals · 1 cells · 1 attempts

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.4 · id 0fbb429cab00 · no registry digest (built locally) · CLI @cursor/sdk 1.0.37 |
| Harnesses | fake |
| Environments | small eca09e8f139f |
| Judge | none by default · threshold 0.8 · version 52dba214af1c |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.6 · @reeval/harness-opencode 0.2.7 · @reeval/harness-goose 0.1.2 · @reeval/harness-pi 0.2.6 · @reeval/harness-cursor-sdk 0.1.4 · @ai-sdk/harness-claude-code 1.0.152-patch.8edc594f · @reeval/harness-codex 0.1.6 · ai 7.0.140 · @ai-sdk/harness 1.0.148 · @ai-sdk/google 4.0.93 · @ai-sdk/typesafe-ai 3.0.18 |
| reeval | 0.8.0 · node 22.14.0 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.4 isn't pushed, so an exact rerun needs this machine's image (id 0fbb429cab00).

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261016T080425Z_nogit_cursor-agent_8zr7.json](../20261016T080425Z_nogit_cursor-agent_8zr7.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ! | evals/build.eval.ts › builds the app | 2s |  |

### ! evals/build.eval.ts › builds the app

**infra**

```
out of memory: 1 process killed at the 128m limit; raise docker({ memory })
```

- Time: setup 1s · agent 0ms · checks 202ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 137: `node -e 'const b = []; for (let i = 0; i < 2048; i++) b.push(Buffer.alloc(1 << 20, 1))'` ([log](evals-build-eval-ts-builds-the-app-442b04/fake-small-docker-8f9fa3/1/checks/1.log))
