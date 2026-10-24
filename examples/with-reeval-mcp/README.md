# with-reeval-mcp

**Shows:** letting the agent you code with read your reeval history. `reeval mcp` serves runs as
read-only MCP tools (`failures`, `transcript`, `compare`, `history` and the `query_*` views), and
[`.mcp.json`](./.mcp.json) (Claude Code) and [`.cursor/mcp.json`](./.cursor/mcp.json) (Cursor)
start it. The eval fails on purpose, so there's a failure to ask about.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. Claude Code or Cursor opened in this directory, to call the tools. A real agent for the
evals needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker, and
`pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here its `multiply` adds, so the tests fail and the run exits 1.
`pnpm eval --profile claude-code` runs the same eval on Claude Code, and `--profile <name>` on any
other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need. Keep `.mcp.json` and `.cursor/mcp.json` at your project's root, beside
`reeval.config.ts`.

**What to look at:** after the run, ask your agent "why did the last reeval run fail?". It calls
the `failures` tool, which answers with each failed check, its log and the transcript's tail
(trimmed here):

```json
{
  "runId": "20261024T145925Z_nogit_cursor-agent_6pmv",
  "summary": { "evals": 1, "attempts": 1, "pass": 0, "fail": 1, … },
  "attempts": [
    {
      "eval": "with-reeval-mcp.eval.ts › adds a tested multiply function",
      "cell": "fake/math/fake",
      "outcome": "fail",
      "failedAssertions": [
        {
          "label": "toSucceed node --test",
          "message": "expected command to succeed, exit code 1\n…  actual: 5\n…"
        }
      ],
      "failedChecks": [
        {
          "command": "node --test",
          "exitCode": 1,
          "logTail": "…not ok 2 - multiply\n…    5 !== 6\n…"
        }
      ],
      "changedFiles": ["modified src/math.js", "modified test/math.test.js"],
      …
    }
  ],
  "cells": [{ "cell": "fake/math/fake", "new": true, "lastPass": null, … }],
  …
}
```

Claude Code loads MCP tools only when a search finds them; a line in `CLAUDE.md` such as "To debug
a reeval run, use the `reeval` MCP server's `failures` tool first" makes it reach for them.

| File | What it is |
|---|---|
| [`with-reeval-mcp.eval.ts`](./with-reeval-mcp.eval.ts) | The eval: one prompt, three checks |
| [`.mcp.json`](./.mcp.json) | Starts `reeval mcp` for Claude Code |
| [`.cursor/mcp.json`](./.cursor/mcp.json) | Starts `reeval mcp` for Cursor, on this directory's config |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace: a `multiply` that adds |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

The [Query history from your agent](../../docs/recipes/agent-mcp.mdx) recipe covers HTTP and
tokens; every tool is on the [reeval mcp](../../docs/reference/cli/mcp.mdx) reference page.
