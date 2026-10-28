# with-capture-journey

**Shows:** a screenshot taken after a vision model drives the page. The agent wires up a "Show
price" button. A check reads the HTML for a click handler; then `c.capture` gets `instructions`,
a model clicks the button the way a person would, and the judge reads the price in the shot.
`capture.model` on the eval names the model that clicks.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. `--profile docker` needs Docker and `ANTHROPIC_API_KEY` in `.env.local`, and downloads
Chrome (`chrome-headless-shell`) the first time. A real agent needs its key too (Claude Code's is
the same one), Docker, and `pnpm reeval image build --profile claude-code` once; under any other
profile the journey still needs `ANTHROPIC_API_KEY`.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check, and a fake judge scores the screenshot 0.9. The fake sandbox
drives no journey and saves a 1×1 placeholder PNG. `pnpm eval --profile docker` runs the same fake
agent in Docker, where Claude clicks the button in real Chrome and judges the shot.
`pnpm eval --profile claude-code` runs it on Claude Code, and `--profile <name>` on any other agent
in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval --profile docker -v` logs each move the model makes:

```text
[reveals#1 fake] 15:18:19 check     capture instruction "Click \"Show price\" if no price shows under it yet; once one shows, you are done"
[reveals#1 fake] 15:18:21 check     capture use click on "Click \"Show price\" if no price shows under it yet; …"
[reveals#1 fake] 15:18:22 check     capture use done on "Click \"Show price\" if no price shows under it yet; …"
[reveals#1 fake] 15:18:23 judge     claude-sonnet-5 · 1s · score 1.00 ≥ 0.8 · pass · …
```

The run record's artifact keeps the instructions, and the model and the moves it took:

```json
{
  "name": "after-click",
  "bytes": 9868,
  "capture": {
    "path": "/",
    "viewport": { "width": 1280, "height": 720 },
    "instructions": ["Click \"Show price\" if no price shows under it yet; once one shows, you are done"],
    "use": { "model": "anthropic/claude-sonnet-5", "moves": 1 },
    …
  }
}
```

The model sees only the goal and the current page on each move, so the goal says when it's met.
"Click the Show price button" never looks finished: the button is still there, so it clicks until
the capture's 32-move cap.

| File | What it is |
|---|---|
| [`with-capture-journey.eval.ts`](./with-capture-journey.eval.ts) | The eval: a check, the server, the journey, the screenshot and the judge |
| [`project/`](./project) | The page the agent starts from: `index.html`, with a dead button, and `server.js` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, the `docker` profile, and the real agents from `../profiles.ts` |

The [Check an app](../../docs/evaluations/task/apps.mdx) page covers `instructions`, the journey's
model and waits.
