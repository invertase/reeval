# with-multi-turn

**Shows:** a session with a follow-up turn, checked and judged as a whole. The agent adds
`multiply(a, b)`, then a second `c.send` asks it to take any number of arguments. The checks run
after both turns, one judge grades the first turn with `on: first`, and another sees every turn
with `state: { turns: 'all' }`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once; each profile's judge uses its own
provider's key (Claude Code's judges on `ANTHROPIC_API_KEY` too).

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge with a fixed score, with no
keys or Docker. It copies the [`fake-agent/`](./fake-agent) fixture into the workspace to mimic
what an agent would produce, so the checks have something to check: `turn-1/` on the first turn
and `turn-2/` on the second. `pnpm eval --profile claude-code` runs the same eval on Claude Code,
and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval --log-order grouped --output-logs full` prints a line per turn, then
the checks and judges, which run after the last turn:

```text
[extends#1 fake]  +0:00 turn 1 done 1ms · 0 tool calls, 2 file edits
[extends#1 fake]  +0:00 turn 2 done 2ms · 0 tool calls, 2 file edits
[extends#1 fake]  +0:00 $ node -e "import('./src/math.js').then((m) => process.exit(m.multiply(2, 3, 4)…  exit 0 26ms
[extends#1 fake]  +0:00 $ node --test  exit 0 76ms
[extends#1 fake]  +0:00 judge  pass 0.90 (≥ 0.8)  Does the test cover multiply(a, b)?
[extends#1 fake]  +0:00 judge  pass 0.90 (≥ 0.8)  Over both turns, does multiply(a, b) keep working as the agent extends it?
```

The attempt's `judge-input.json` has what each judge saw: the first turn's prompt and diff for
`on: first`, and both turns' prompts and replies for `turns: 'all'`:

```text
"turns": [
  { "task": "Add a multiply(a, b) function to src/math.js, …", "output": "I added multiply(a, b) …" },
  { "task": "Now let multiply take any number of arguments: …", "output": "multiply now takes …" }
],
```

| File | What it is |
|---|---|
| [`with-multi-turn.eval.ts`](./with-multi-turn.eval.ts) | The eval: two turns, two checks and two judges |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent writes on each turn |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, and the real agents from `../profiles.ts` |

Turns, `on` and `state` are in the [Multi-turn evals](../../docs/guide/multi-turn.mdx) guide.
