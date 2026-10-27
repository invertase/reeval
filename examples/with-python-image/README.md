# with-python-image

**Shows:** an official toolchain image as the sandbox. The environment's
`docker({ from: 'python:3.12-slim' })` starts from Python's image, and reeval bakes Node, git and
the agent onto it the first time, then reuses it. The agent writes `fizzbuzz.py` and its
`unittest` tests, and the eval runs them with `python3`.

**Needs:** Docker, even for the fake agent; in this repo, run `pnpm install && pnpm build` at the
root first. A real agent also needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code)
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; it still runs in the Python image. `pnpm eval --profile
claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the first run prepares the image before any attempt starts, and the cell is
named after the sandbox's `id`:

```text
preparing 1 sandbox: python
✓ python ready 23s
reeval 0.13.0 · run … · 1 eval file · harness fake · sandbox python · concurrency 4 · stream logs

pass             writes and tests fizzbuzz in Python
```

`pnpm reeval image build --dry-run` then shows the image reeval built on the tag's digest:
`✓ from python:3.12-slim  reeval-sandbox:cursor-0.1.6-python-3-12-slim-375f4a61`. Later runs reuse
it even when the tag moves; pin a digest (`python:3.12-slim@sha256:…`) to never move.

| File | What it is |
|---|---|
| [`with-python-image.eval.ts`](./with-python-image.eval.ts) | The eval: the Python environment, one prompt, two checks |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Toolchain images are in the [Choose a sandbox](../../docs/configuration/sandboxes/index.mdx) page, and
complete setups in the [Add toolchains](../../docs/configuration/environments/toolchains.mdx) page.
