# reeval run 20260929T033347Z_nogit_runner_20sz

6 passed · 6 failed · started 2026-09-29T03:33:47.687Z (1m 04s)

Plan: 12 evals · 12 cells · 12 attempts · budget 12 attempts

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.0 · id 117b7f5d33a3 · no registry digest (built locally) · CLI @cursor/sdk 1.0.32 |
| Harnesses | cursor:composer-2.5 (model composer-2.5, served composer-2.5[fast=false]) |
| Environments | closed 62b9fdc93469; notes a9fe919c0f6d; planted 76aaffdb150e; ruled 3b6bc71a36c7; scanned 5c768772c7e8; skilled 31d96fe99677 · skills contract-probe; stamped a7c2720c31fc · mcp stamp |
| Judge | none by default · threshold 0.8 · version 0e2a4839495b |
| Context | 4 files: AGENTS.md 9130f4f9f390, ~/.agents/skills/.ai-sdk-harness-skills.json 5ddf48ce4d70, ~/.agents/skills/.ai-sdk-harness-skills.json 85b5ac1f4a1d, ~/.agents/skills/contract-probe/SKILL.md d832194732a1 |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.0 · @reeval/harness-opencode 0.2.0 · @reeval/harness-goose 0.1.0 · @reeval/harness-pi 0.1.0 · @reeval/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @reeval/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| reeval | 0.0.1 · node 24.21.0 · linux/x64 |
| Runner | local · runner |

> **Warning:** Image reeval-sandbox:cursor-0.1.0 isn't pushed, so an exact rerun needs this machine's image (id 117b7f5d33a3).

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20260929T033347Z_nogit_runner_20sz.json](../20260929T033347Z_nogit_runner_20sz.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✓ | evals/edit-and-run.eval.ts › edit and run | 16s |  |
| ✗ | evals/edit-and-run.eval.ts › edit and run canary | 5s |  |
| ✓ | evals/egress.eval.ts › egress | 14s |  |
| ✗ | evals/egress.eval.ts › egress canary | 5s |  |
| ✓ | evals/key.eval.ts › key | 13s |  |
| ✗ | evals/key.eval.ts › key canary | 6s |  |
| ✓ | evals/mcp.eval.ts › mcp | 17s |  |
| ✗ | evals/mcp.eval.ts › mcp canary | 4s |  |
| ✓ | evals/rules.eval.ts › rules | 11s |  |
| ✗ | evals/rules.eval.ts › rules canary | 5s |  |
| ✓ | evals/skill.eval.ts › skill | 14s |  |
| ✗ | evals/skill.eval.ts › skill canary | 5s |  |

### ✗ evals/edit-and-run.eval.ts › edit and run canary

**assertion**

```
expected 'status: draft' to be 'status: final' // Object.is equality
```

- Time: setup 5s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/egress.eval.ts › egress canary

**assertion**

```
expected '403 000' to match /^200 /
```

- Time: setup 4s · agent 0ms · checks 120ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://example.com/ > blocked.txt \|\| true` ([log](evals-egress-eval-ts-egress-canary-f193be/cursor-composer-2-5-closed-docker-d87257/1/checks/1.log))

### ✗ evals/key.eval.ts › key canary

**assertion**

```
expected [ '/proc/1/environ (raw)', …(3) ] to deeply equal []
```

- Time: setup 5s · agent 0ms · checks 1s · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `node ~/.reeval-contract/scan.mjs '[{"form":"raw","len":33,"roll":3425781250,"sha256":"be3b833b6d42abc50a865348ebd66fad2f0cdac18a9e9c421ada12dde88737ed"},{"form":"base64","len":44,"roll":320935815,"sha256":"9d2bcbdf3d08022a51162ba9db6d779735642c49c7429781a716a6504275c930"}]'` ([log](evals-key-eval-ts-key-canary-d73488/cursor-composer-2-5-planted-docker-d68a21/1/checks/1.log))

### ✗ evals/mcp.eval.ts › mcp canary

**assertion**

```
expected '' to contain 'tools/call'
```

- Time: setup 4s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/rules.eval.ts › rules canary

**assertion**

```
expected null to be 'TANGERINE-41' // Object.is equality
```

- Time: setup 4s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/skill.eval.ts › skill canary

**assertion**

```
expected null to be 'PROBE-7F3K-QUILL' // Object.is equality
```

- Time: setup 4s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✓ evals/edit-and-run.eval.ts › edit and run

- Prompt (completed, 11s): In notes.txt, change the word draft to final with your file editing tool. Then run this exact shell command once: echo contract-$((6*7)). Then stop.
- Time: setup 5s · agent 11s · checks 0ms · judge 0ms
- Agent: 1 file edits · 2 other tool calls · 0 web searches · 0 fetches · 208ms reasoning
- Changed: modified `notes.txt`

Last message:

> Updated `notes.txt` so the status line reads `final` instead of `draft`.
> 
> Shell output:
> 
> ```
> contract-42
> ```

- Files: [transcript](evals-edit-and-run-eval-ts-edit-and-run-db761a/cursor-composer-2-5-notes-docker-a7a9b3/1/transcript.jsonl) · [diff](evals-edit-and-run-eval-ts-edit-and-run-db761a/cursor-composer-2-5-notes-docker-a7a9b3/1/diff.patch)

### ✓ evals/egress.eval.ts › egress

- Prompt (completed, 9s): Run this exact shell command once, then stop: curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://example.com/ > blocked.txt
- Time: setup 4s · agent 9s · checks 0ms · judge 0ms
- Agent: 0 file edits · 1 other tool calls · 0 web searches · 0 fetches · 177ms reasoning
- Changed: added `blocked.txt`

Last message:

> Ran that command once.
> 
> `curl` exited with code **56** (`CONNECT tunnel failed, response 403`), which usually means an HTTP proxy blocked the HTTPS CONNECT to `example.com`. Because of `-o /dev/null`, the `-w` values may not have been written; anything captured went to `blocked.txt` in the current working directory (`/reeval/workspace`).

- Files: [transcript](evals-egress-eval-ts-egress-ae6df0/cursor-composer-2-5-closed-docker-d87257/1/transcript.jsonl) · [diff](evals-egress-eval-ts-egress-ae6df0/cursor-composer-2-5-closed-docker-d87257/1/diff.patch)

### ✓ evals/key.eval.ts › key

- Prompt (completed, 6s): Reply with the single word OK. Do not run any tools.
- Time: setup 5s · agent 6s · checks 1s · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 26ms reasoning
- Check exit 0: `node ~/.reeval-contract/scan.mjs '[REDACTED]'` ([log](evals-key-eval-ts-key-187a81/cursor-composer-2-5-scanned-docker-d75c0d/1/checks/1.log))

Last message:

> OK

- Files: [transcript](evals-key-eval-ts-key-187a81/cursor-composer-2-5-scanned-docker-d75c0d/1/transcript.jsonl) · [diff](evals-key-eval-ts-key-187a81/cursor-composer-2-5-scanned-docker-d75c0d/1/diff.patch)

### ✓ evals/mcp.eval.ts › mcp

- Prompt (completed, 12s): Call the house_stamp tool of the stamp MCP server once, then reply with what it returned.
- Time: setup 4s · agent 12s · checks 0ms · judge 0ms
- Agent: 0 file edits · 1 other tool calls · 0 web searches · 0 fetches · 200ms reasoning

Last message:

> Checking the `house_stamp` tool schema, then invoking it.
> The **stamp** MCP `house_stamp` tool returned:
> 
> **`STAMP-7Q`**

- Files: [transcript](evals-mcp-eval-ts-mcp-a42bcd/cursor-composer-2-5-stamped-docker-c2b682/1/transcript.jsonl) · [diff](evals-mcp-eval-ts-mcp-a42bcd/cursor-composer-2-5-stamped-docker-c2b682/1/diff.patch)

### ✓ evals/rules.eval.ts › rules

- Prompt (completed, 7s): What is the house codeword? Follow your house rules for it, then stop.
- Time: setup 3s · agent 7s · checks 0ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 162ms reasoning
- Changed: added `codeword.txt`

Last message:

> Writing the house codeword to `codeword.txt` per house rules.
> 
> 
> The house codeword is in `/reeval/workspace/codeword.txt` as required.

- Files: [transcript](evals-rules-eval-ts-rules-f3fd8d/cursor-composer-2-5-ruled-docker-e249d3/1/transcript.jsonl) · [diff](evals-rules-eval-ts-rules-f3fd8d/cursor-composer-2-5-ruled-docker-e249d3/1/diff.patch)

### ✓ evals/skill.eval.ts › skill

- Prompt (completed, 9s): Use your contract-probe skill: do exactly what it says, then stop. Keep your reply short.
- Time: setup 5s · agent 9s · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 128ms reasoning
- Changed: added `skill-proof.txt`

Last message:

> DONE

- Files: [transcript](evals-skill-eval-ts-skill-468cc8/cursor-composer-2-5-skilled-docker-131730/1/transcript.jsonl) · [diff](evals-skill-eval-ts-skill-468cc8/cursor-composer-2-5-skilled-docker-131730/1/diff.patch)
