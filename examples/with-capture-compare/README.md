# with-capture-compare

**Shows:** a pairwise question asked about screenshots. Both arms add a "Sign up" button; the
variant has a brand skill. Each attempt captures its page as `home`, and the question
(`across: 'environment'`, with `diff: true` and `artifacts: ['home']`) sends each side's own screenshot beside its diff, so the vote can rest on
how the page looks.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. `--profile docker` needs Docker, and downloads Chrome (`chrome-headless-shell`) the first
time. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once. Real votes need `analysis.model` set to
a model that takes images, and its key.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check: a plain button without the skill, the brand's blue one with it.
The fake sandbox saves a 1×1 placeholder for each screenshot, and a fake analysis model votes from
the diffs. `pnpm eval --profile docker` runs the same fake agent in Docker, where Chrome takes the
real screenshots, still with no keys. `pnpm eval --profile claude-code` runs it on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts); the fake
analysis model still votes until you set a real one.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the question's tally under the eval:

```text
pass             adds a sign-up button
  arm              pass
  site             4 of 4
  brand            4 of 4
  question  Which Sign up button is blue with white text and rounded corners?
    site           won 0 of 8
    brand          won 8 of 8
```

Each pair is asked twice, with the sides swapped. With `analysis.model: 'anthropic/claude-sonnet-5'`
and `--profile docker`, Claude voted the same way from the real screenshots, and the record names
the capture each side sent:

```json
{
  "question": "Which Sign up button is blue with white text and rounded corners?",
  "artifacts": ["home"],
  "model": "anthropic/claude-sonnet-5",
  "votes": [
    { "a": "site", "b": "brand", "winner": "brand", "swapped": false, "artifacts": { "a": ["home"], "b": ["home"] }, … },
    { "a": "site", "b": "brand", "winner": "brand", "swapped": true, "artifacts": { "a": ["home"], "b": ["home"] }, … }
  ]
}
```

| File | What it is |
|---|---|
| [`with-capture-compare.eval.ts`](./with-capture-compare.eval.ts) | The eval: the compare, its question on `home`, the check and the screenshot |
| [`project/`](./project) | The site the agent starts from: `index.html` and `server.js` |
| [`skills/brand/`](./skills/brand) | The variant's skill: the brand's button style |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace, with and without the skill |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and analysis model, the `docker` profile, and the real agents from `../profiles.ts` |

The [Check an app](../../docs/evaluations/task/apps.mdx) page covers comparing two arms'
screenshots, and [Ask questions across attempts](../../docs/evaluations/grading/questions.mdx) what each side shows.
