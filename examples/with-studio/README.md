# with-studio

**Shows:** browsing your runs in the studio, and building it as a static site. The agent adds
`multiply(a, b)` to a small package; `--record` copies the run into `.history/`, `reeval studio`
serves every run, eval, transcript and diff on `127.0.0.1`, and `reeval studio build` writes the
same app as files for any static host.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A browser to open the studio in. A real agent needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code), Docker, and `pnpm reeval image build --profile claude-code`
once.

**Run:**

```bash
pnpm eval --record
pnpm reeval studio
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code --record` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).
The studio shows every run, whichever agent ran it.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the studio prints the URL to open, with its session token:

```text
reeval studio · with-studio · .history/
  http://127.0.0.1:4984/?token=…
Ctrl-C to stop.
```

Unrecorded runs from `.reeval/runs/` show there too, labelled scratch. A static build takes only
recorded runs, unless you add `--scratch`:

```text
$ pnpm reeval studio build --out site
built site/: 1 run, 12 files, 736 KB (records, transcripts, diffs, logs and judge inputs)
Serve it from any static host. Anyone who can open it can read every included file.
```

| File | What it is |
|---|---|
| [`with-studio.eval.ts`](./with-studio.eval.ts) | The eval: one prompt, three checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Every page of the studio is in [Browse studio runs](../../docs/results/studio.mdx).
