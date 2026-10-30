# with-dockerfile

**Shows:** a sandbox from your own Dockerfile. [`sqlite/Dockerfile`](./sqlite/Dockerfile) starts
`FROM ${REEVAL_BASE}`, reeval's image for the agent, adds `sqlite3` and seeds `/opt/shop.db`.
The environment points `docker({ dockerfile })` at it, and the agent writes a query on the
database.

**Needs:** Docker, even for the fake agent; in this repo, run `pnpm install && pnpm build` at the
root first. A real agent also needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code)
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; it still runs in the Dockerfile's image, where the database is.
`pnpm eval --profile claude-code` runs the same eval on Claude Code, and `--profile <name>` on any
other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm reeval image build --dry-run` builds the Dockerfile on the agent's image,
so the result already has the agent and is used as is:

```text
images  1 sandbox image (nothing built: --dry-run)
docker:sqlite · cursor · 1 eval
  + dockerfile sqlite/Dockerfile  reeval-dockerfile:sqlite-<context + reeval image id>  (to build: not built yet (reeval-dockerfile:sqlite-cd0d64c1617074f9))
  ✓ harness                       reeval-dockerfile:sqlite-<context + reeval image id>  (ready: reeval-sandbox:cursor-0.1.8 built (3fa1c0ba62b4))
```

The image is tagged by the build context's content, so editing the Dockerfile or `seed.sql`
builds anew. `RUN` lines build as root, but the agent runs as the `reeval` user.

| File | What it is |
|---|---|
| [`with-dockerfile.eval.ts`](./with-dockerfile.eval.ts) | The eval: the Dockerfile environment, one prompt, two checks |
| [`sqlite/`](./sqlite) | The Dockerfile and the `seed.sql` it loads |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Dockerfiles, `from` and `install` are in the
[Choose a sandbox](../../docs/configuration/sandboxes/index.mdx) page.
