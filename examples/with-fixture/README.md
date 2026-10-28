# with-fixture

**Shows:** seeding the workspace from files in the example. `directory('./project', { glob })`
copies a small CSV package in without its maintainer notes, `file()` adds a sample CSV file, and a
string adds the `.gitignore`. The agent adds `stringifyCsv(rows)` with a test that round-trips the
sample, and the eval runs the tests and checks the sample is untouched with `not.toHaveChanged`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

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

**What to look at:** the plan lists the files each cell starts with, so you can see what the
`glob` kept before anything runs (`NOTES.md` isn't there):

```bash
pnpm reeval run --dry-run --json
```

```text
…
          "files": [
            ".gitignore",
            "data/people.csv",
            "package.json",
            "src/csv.js",
            "test/csv.test.js"
          ]
…
```

| File | What it is |
|---|---|
| [`with-fixture.eval.ts`](./with-fixture.eval.ts) | The eval: the seeded environment, and three checks |
| [`project/`](./project) | The package the agent starts from, and the notes the `glob` leaves out |
| [`data/people.csv`](./data/people.csv) | The sample `file()` places at `data/people.csv` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`directory()`, its `glob` and `file()` are in the [Environment helpers reference](../../docs/reference/environment-helpers.mdx)
reference.
