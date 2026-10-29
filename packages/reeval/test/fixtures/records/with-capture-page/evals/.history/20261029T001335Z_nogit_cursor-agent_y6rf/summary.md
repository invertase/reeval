# reeval run 20261029T001335Z_nogit_cursor-agent_y6rf

3 pass · started 2026-10-29T00:13:35.542Z (4s)

Plan: 3 evals · 3 cells · 3 attempts

## Results

```text
pass             captures a page that renders
  2 page errors in capture "sign-up" → .reeval/runs/20261029T001335Z_nogit_cursor-agent_y6rf/evals-pages-eval-ts-captures-a-page-that-renders-96d33f/fake-site-docker-a17d85/1/artifacts/sign-up.capture.json

pass             captures a page that throws
  1 page error in capture "blank" → .reeval/runs/20261029T001335Z_nogit_cursor-agent_y6rf/evals-pages-eval-ts-captures-a-page-that-throws-01af2a/fake-site-docker-a17d85/1/artifacts/blank.capture.json

pass             captures a missing page

3 pass
```

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.6 · id 56a1506c02b1 · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | fake |
| Environments | site 36d87a613ef6 |
| Judge | none by default · threshold 0.8 · version 717433497d3f |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.12 · @reeval/harness-opencode 0.2.10 · @reeval/harness-goose 0.1.6 · @reeval/harness-pi 0.2.8 · @reeval/harness-cursor-sdk 0.1.6 · @ai-sdk/harness-claude-code 1.0.160-patch.b17cde50 · @reeval/harness-codex 0.1.9 · @reeval/harness-fx 0.1.3 · @reeval/harness-grok-build 0.1.6 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/anthropic 4.0.83 · @ai-sdk/google 4.0.100 · @ai-sdk/openai 4.0.97 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.15.1 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.6 isn't pushed, so an exact rerun needs this machine's image (id 56a1506c02b1).

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261029T001335Z_nogit_cursor-agent_y6rf.json](../20261029T001335Z_nogit_cursor-agent_y6rf.json) · artifacts: all

## Attempts

### ✓ evals/pages.eval.ts › captures a page that renders

- Prompt (completed, 0ms): Build the sign-up page.
- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-pages-eval-ts-captures-a-page-that-renders-96d33f/fake-site-docker-a17d85/1/transcript.jsonl) · [diff](evals-pages-eval-ts-captures-a-page-that-renders-96d33f/fake-site-docker-a17d85/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-pages-eval-ts-captures-a-page-that-renders-96d33f/fake-site-docker-a17d85/1/snapshots/final)

### ✓ evals/pages.eval.ts › captures a page that throws

- Prompt (completed, 0ms): Build the sign-up page.
- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-pages-eval-ts-captures-a-page-that-throws-01af2a/fake-site-docker-a17d85/1/transcript.jsonl) · [diff](evals-pages-eval-ts-captures-a-page-that-throws-01af2a/fake-site-docker-a17d85/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-pages-eval-ts-captures-a-page-that-throws-01af2a/fake-site-docker-a17d85/1/snapshots/final)

### ✓ evals/pages.eval.ts › captures a missing page

- Prompt (completed, 1ms): Build the sign-up page.
- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

Last message:

> Done.

- Files: [transcript](evals-pages-eval-ts-captures-a-missing-page-a7187c/fake-site-docker-a17d85/1/transcript.jsonl) · [diff](evals-pages-eval-ts-captures-a-missing-page-a7187c/fake-site-docker-a17d85/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-pages-eval-ts-captures-a-missing-page-a7187c/fake-site-docker-a17d85/1/snapshots/final)
