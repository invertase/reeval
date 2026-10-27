# with-capture

**Shows:** judging a screenshot of the agent's page. The agent adds a "Sign up" button to a
one-page site; the eval starts its server with `c.serve`, screenshots it with `c.capture`, and
sends the PNG to the judge with `artifacts`. A deterministic check reads the HTML first.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. `--profile docker` needs Docker, and downloads Chrome (`chrome-headless-shell`) the first
time. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once; its judge must take images, as each
shared profile's does.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check, and a fake judge scores the screenshot 0.9. The fake sandbox
takes no real screenshot: it saves a 1×1 placeholder PNG. `pnpm eval --profile docker` runs the
same fake agent in Docker, where Chrome takes the real one, still with no keys.
`pnpm eval --profile claude-code` runs it on Claude Code, and `--profile <name>` on any other agent
in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the screenshot, in the attempt's directory under `.reeval/runs/`:

```text
.reeval/runs/<run>/with-capture-eval-ts-adds-a-sign-up-button-bbe9e5/fake-site-docker-a17d85/1/
  artifacts/home.png
  diff.patch
  judge-input.json
  transcript.jsonl
```

With `--profile docker` it's the 1280×720 page with its blue button. The run record's judgment
names the PNG it was sent:

```json
{
  "verdict": "pass",
  "score": 0.9,
  "threshold": 0.8,
  "question": "Does the screenshot show a button labeled \"Sign up\" under the intro paragraph?",
  "model": "fake",
  "artifacts": [{ "name": "home", "path": "artifacts/home.png", "bytes": 11931, "mediaType": "image/png", … }]
}
```

| File | What it is |
|---|---|
| [`with-capture.eval.ts`](./with-capture.eval.ts) | The eval: a check, the server, the screenshot and the judge |
| [`project/`](./project) | The site the agent starts from: `index.html` and `server.js` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, the `docker` profile, and the real agents from `../profiles.ts` |

The [Capturing UI](../../docs/recipes/capturing-ui.mdx) recipe covers `c.serve`, `c.capture`,
waits and judging the screenshot.
