# with-dart

**Shows:** an official toolchain image on a cloud VM. The `dart-boat` environment's
`boat({ from: 'dart:3.5' })` and the `dart-daytona` environment's `daytona({ from: 'dart:3.5' })`
start from Dart's image: the first run builds it, with Node, git and the agent, into a saved
snapshot on each provider, and later runs start from that snapshot. The agent writes
`fizzbuzz.dart` and a script that checks it, and the eval runs them with `dart`.

**Needs:** `BOAT_API_KEY` for the Boat cell and `DAYTONA_API_KEY` for the Daytona cell, even for
the fake agent. `package.json` adds `@boatdev/sdk` and `@daytona/sdk`, which `boat()` and
`daytona()` load; in this repo, run `pnpm install && pnpm build` at the root first. A real agent also needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code).

**Run:**

```bash
pnpm eval --trait provider=boat     # the Boat cell
pnpm eval --trait provider=daytona  # the Daytona cell
pnpm eval                           # both
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no agent key. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; it still runs in the Dart image on each provider. `pnpm eval
--profile claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other agent
in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the first run builds the image before any attempt starts, and the cell is
named after the sandbox and its image:

```text
…
  ➜  Sandbox:   boat:dart:3.5
…
  ◆  Preparing 1 sandbox (boat:dart:3.5)...
  ◌  boat:dart:3.5 building image reeval-img-c72180f4c015...
  ✓  boat:dart:3.5 ready, built image reeval-img-c72180f4c015 3m 40s
  images: 1 ready (1 built in 3m 40s)
  ◆  Running...

with-dart.eval.ts
  ✓ writes and tests fizzbuzz in Dart  1 of 1 run passed
```

A later run says `✓ boat:dart:3.5 ready, from saved image reeval-img-c72180f4c015`.
`pnpm reeval image list` shows the snapshots, and `pnpm reeval image clean --all` deletes them. On
Boat each attempt runs in a container of the image, so the default egress policy holds there; a
Daytona sandbox keeps its own network, so `dart-daytona` sets `egress: 'allow-all'`.

| File | What it is |
|---|---|
| [`with-dart.eval.ts`](./with-dart.eval.ts) | The eval: the Dart environments on Boat and Daytona, one prompt, two checks |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Boat is in the [Run on Boat](../../docs/configuration/sandboxes/boat.mdx) page, and every
`boat()` and `daytona()` option in the [options reference](../../docs/reference/options.mdx).
