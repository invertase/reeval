# with-git-workspace

**Shows:** starting every attempt from a pinned repository. `workspace: git(repo, { ref, path,
init })` fetches one directory of a public GitHub repository at a full commit SHA, and
`init: true` gives the workspace a `.git` with one commit of it. The agent adds `subtract(a, b)`,
and the eval runs the tests and reads `git status`.

**Needs:** the network, to fetch the repository from GitHub; nothing else for the fake agent. In
this repo, run `pnpm install && pnpm build` at the root first. A real agent needs its key in
`.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker, and
`pnpm reeval image build --profile claude-code` once. A private repository needs a token too: add
`token: 'GITHUB_TOKEN'` and put `GITHUB_TOKEN` in `.env.local`.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the line under the plan. reeval fetches the repository once per run, on the
host, before any attempt, and names the commit every attempt starts from:

```text
plan  run 20261024T150112Z_… · 1 eval · 1 cell · 1 attempt · ~1s serial
workspace github:invertase/reeval#f60f255edb8a110d42d2ae4e483bd8555168b854:examples/with-checks/project at f60f255edb8a
…
pass             adds subtract to a pinned repository
```

A branch or no `ref` warns in the plan, since the code under the eval could change between runs.

| File | What it is |
|---|---|
| [`with-git-workspace.eval.ts`](./with-git-workspace.eval.ts) | The eval: the pinned workspace, and two checks |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`git()` and its options are in the [Helpers](../../docs/reference/helpers.mdx#git) reference.
