# reeval run 20260929T033538Z_nogit_runner_f3z3

6 passed · 6 failed · started 2026-09-29T03:35:38.563Z (1m 45s)

Plan: 12 evals · 12 cells · 12 attempts · budget 12 attempts

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | reeval-sandbox:claude-code-1.0.128-patch.5d1c985c · id 13db7c0f24b7 · no registry digest (built locally) · CLI 2.1.276 (Claude Code) |
| Harnesses | claude-code:claude-haiku-4-5 (model claude-haiku-4-5, served claude-haiku-4-5) |
| Environments | closed 62b9fdc93469; notes a9fe919c0f6d; planted 76aaffdb150e; ruled 3b6bc71a36c7; scanned 5c768772c7e8; skilled 31d96fe99677 · skills contract-probe; stamped a7c2720c31fc · mcp stamp |
| Judge | none by default · threshold 0.8 · version 0e2a4839495b |
| Context | 4 files: CLAUDE.md 9130f4f9f390, ~/.claude/skills/.ai-sdk-harness-skills.json 5ddf48ce4d70, ~/.claude/skills/.ai-sdk-harness-skills.json dcc327bce3fa, ~/.claude/skills/contract-probe/SKILL.md 7e4705bd98e7 |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.0 · @reeval/harness-opencode 0.2.0 · @reeval/harness-goose 0.1.0 · @reeval/harness-pi 0.1.0 · @reeval/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @reeval/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| reeval | 0.0.1 · node 24.21.0 · linux/x64 |
| Runner | local · runner |

> **Warning:** Image reeval-sandbox:claude-code-1.0.128-patch.5d1c985c isn't pushed, so an exact rerun needs this machine's image (id 13db7c0f24b7).

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20260929T033538Z_nogit_runner_f3z3.json](../20260929T033538Z_nogit_runner_f3z3.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✓ | evals/edit-and-run.eval.ts › edit and run | 24s |  |
| ✗ | evals/edit-and-run.eval.ts › edit and run canary | 16s |  |
| ✓ | evals/egress.eval.ts › egress | 20s |  |
| ✗ | evals/egress.eval.ts › egress canary | 11s |  |
| ✓ | evals/key.eval.ts › key | 20s |  |
| ✗ | evals/key.eval.ts › key canary | 16s |  |
| ✓ | evals/mcp.eval.ts › mcp | 20s |  |
| ✗ | evals/mcp.eval.ts › mcp canary | 12s |  |
| ✓ | evals/rules.eval.ts › rules | 18s |  |
| ✗ | evals/rules.eval.ts › rules canary | 12s |  |
| ✓ | evals/skill.eval.ts › skill | 18s |  |
| ✗ | evals/skill.eval.ts › skill canary | 12s |  |

### ✗ evals/edit-and-run.eval.ts › edit and run canary

**assertion**

```
expected 'status: draft' to be 'status: final' // Object.is equality
```

- Time: setup 15s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/egress.eval.ts › egress canary

**assertion**

```
expected '403 000' to match /^200 /
```

- Time: setup 11s · agent 0ms · checks 103ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://example.com/ > blocked.txt \|\| true` ([log](evals-egress-eval-ts-egress-canary-f193be/claude-code-claude-haiku-4-5-closed-docker-57fce2/1/checks/1.log))

### ✗ evals/key.eval.ts › key canary

**assertion**

```
expected [ '/proc/1/environ (raw)', …(4) ] to deeply equal []
```

- Time: setup 14s · agent 0ms · checks 2s · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `node ~/.reeval-contract/scan.mjs '[{"form":"raw","len":33,"roll":3425781250,"sha256":"be3b833b6d42abc50a865348ebd66fad2f0cdac18a9e9c421ada12dde88737ed"},{"form":"base64","len":44,"roll":320935815,"sha256":"9d2bcbdf3d08022a51162ba9db6d779735642c49c7429781a716a6504275c930"}]'` ([log](evals-key-eval-ts-key-canary-d73488/claude-code-claude-haiku-4-5-planted-docker-21030a/1/checks/1.log))

### ✗ evals/mcp.eval.ts › mcp canary

**assertion**

```
expected '' to contain 'tools/call'
```

- Time: setup 12s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/rules.eval.ts › rules canary

**assertion**

```
expected null to be 'TANGERINE-41' // Object.is equality
```

- Time: setup 11s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/skill.eval.ts › skill canary

**assertion**

```
expected null to be 'PROBE-7F3K-QUILL' // Object.is equality
```

- Time: setup 11s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✓ evals/edit-and-run.eval.ts › edit and run

- Prompt (completed, 8s): In notes.txt, change the word draft to final with your file editing tool. Then run this exact shell command once: echo contract-$((6*7)). Then stop.
- Time: setup 15s · agent 8s · checks 0ms · judge 0ms
- Agent: 1 file edits · 2 other tool calls · 0 web searches · 0 fetches · 2s reasoning
- Changed: modified `notes.txt`

Last message:

> Done. I've changed "draft" to "final" in notes.txt and ran the command, which output `contract-42`.

- Files: [transcript](evals-edit-and-run-eval-ts-edit-and-run-db761a/claude-code-claude-haiku-4-5-notes-docker-13c892/1/transcript.jsonl) · [diff](evals-edit-and-run-eval-ts-edit-and-run-db761a/claude-code-claude-haiku-4-5-notes-docker-13c892/1/diff.patch)

### ✓ evals/egress.eval.ts › egress

- Prompt (completed, 8s): Run this exact shell command once, then stop: curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://example.com/ > blocked.txt
- Time: setup 11s · agent 8s · checks 0ms · judge 0ms
- Agent: 0 file edits · 1 other tool calls · 0 web searches · 0 fetches · 4s reasoning
- Changed: added `blocked.txt`

Last message:

> Done. The command ran and encountered a connectivity error: HTTPS connections to external URLs appear to be blocked by the network (curl error 56: CONNECT tunnel failed with a 403 response from the proxy/firewall).

- Files: [transcript](evals-egress-eval-ts-egress-ae6df0/claude-code-claude-haiku-4-5-closed-docker-57fce2/1/transcript.jsonl) · [diff](evals-egress-eval-ts-egress-ae6df0/claude-code-claude-haiku-4-5-closed-docker-57fce2/1/diff.patch)

### ✓ evals/key.eval.ts › key

- Prompt (completed, 3s): Reply with the single word OK. Do not run any tools.
- Time: setup 14s · agent 3s · checks 2s · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 582ms reasoning
- Check exit 0: `node ~/.reeval-contract/scan.mjs '[REDACTED]'` ([log](evals-key-eval-ts-key-187a81/claude-code-claude-haiku-4-5-scanned-docker-eb062a/1/checks/1.log))

Last message:

> OK

- Files: [transcript](evals-key-eval-ts-key-187a81/claude-code-claude-haiku-4-5-scanned-docker-eb062a/1/transcript.jsonl) · [diff](evals-key-eval-ts-key-187a81/claude-code-claude-haiku-4-5-scanned-docker-eb062a/1/diff.patch)

### ✓ evals/mcp.eval.ts › mcp

- Prompt (completed, 7s): Call the house_stamp tool of the stamp MCP server once, then reply with what it returned.
- Time: setup 12s · agent 7s · checks 0ms · judge 0ms
- Agent: 0 file edits · 2 other tool calls · 0 web searches · 0 fetches · 3s reasoning

Last message:

> The house_stamp tool returned: **STAMP-7Q**

- Files: [transcript](evals-mcp-eval-ts-mcp-a42bcd/claude-code-claude-haiku-4-5-stamped-docker-7e166c/1/transcript.jsonl) · [diff](evals-mcp-eval-ts-mcp-a42bcd/claude-code-claude-haiku-4-5-stamped-docker-7e166c/1/diff.patch)

### ✓ evals/rules.eval.ts › rules

- Prompt (completed, 6s): What is the house codeword? Follow your house rules for it, then stop.
- Time: setup 11s · agent 6s · checks 0ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 2s reasoning
- Changed: added `codeword.txt`

Last message:

> Done.

- Files: [transcript](evals-rules-eval-ts-rules-f3fd8d/claude-code-claude-haiku-4-5-ruled-docker-a010bf/1/transcript.jsonl) · [diff](evals-rules-eval-ts-rules-f3fd8d/claude-code-claude-haiku-4-5-ruled-docker-a010bf/1/diff.patch)

### ✓ evals/skill.eval.ts › skill

- Prompt (completed, 6s): Use your contract-probe skill: do exactly what it says, then stop. Keep your reply short.
- Time: setup 11s · agent 6s · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 2s reasoning
- Changed: added `skill-proof.txt`

Last message:

> DONE

- Files: [transcript](evals-skill-eval-ts-skill-468cc8/claude-code-claude-haiku-4-5-skilled-docker-7add5d/1/transcript.jsonl) · [diff](evals-skill-eval-ts-skill-468cc8/claude-code-claude-haiku-4-5-skilled-docker-7add5d/1/diff.patch)
