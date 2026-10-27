# with-docker-install

**Shows:** a tool the agent needs, baked onto reeval's image. The environment's
`docker({ install })` adds `jq`, and reeval builds that layer once and caches it by the exact
command list. The agent writes `count.sh`, which counts the large orders in `orders.json` with
`jq`.

**Needs:** Docker, even for the fake agent; in this repo, run `pnpm install && pnpm build` at the
root first. A real agent also needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code)
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; it still runs in the environment's sandbox, so `jq` comes from the
install layer. `pnpm eval --profile claude-code` runs the same eval on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm reeval image build --dry-run` lists the install layer on top of the
agent's image, here after the first run built it:

```text
images  1 sandbox image (nothing built: --dry-run)
docker+0ab0e263 · cursor + install · 1 eval
  ✓ base               reeval-sandbox:cursor-0.1.6  (ready: built (3fa1c0ba62b4))
  ✓ install 1 command  reeval-install:1d7d61958ab1a130  (ready: built (15642b46f47f))
```

Any edit to the command list builds a new layer. Install commands never see secrets or the
workspace; per-attempt steps belong in the environment's `setup`.

| File | What it is |
|---|---|
| [`with-docker-install.eval.ts`](./with-docker-install.eval.ts) | The eval: the `jq` environment, one prompt, two checks |
| [`project/`](./project) | What the agent starts from: `orders.json` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`install`, `from` and `dockerfile` are in the
[Choose a sandbox](../../docs/integrations/sandboxes/index.mdx) page.
