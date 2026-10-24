# with-pass-rate

**Shows:** a cell that passes on most tries, not all of them. The agent adds `multiply(a, b)` five
times (`runs: 5`), and `gate: { passRate: 0.6 }` passes the cell when three or more tries pass:
a pass@1 threshold. The default gate, `'all'`, needs all five (pass^k), which an agent that's
right four times in five manages only a third of the time.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; with `flakeRate: 0.2` it writes nothing on about one try in five, at
random, so each run's count differs. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the tries row. Two of five failed here, and the cell still passes:

```text
pass             adds a tested multiply function
  5 tries          3 of 5
  multiply added   3 of 5
    expected src/math.js to match /export function multiply/
  +1 more passed
```

On a run with three failures it reads `fail` and `2 of 5`, and the run exits 1. Five tries is a
small sample: `pnpm eval --runs 100` shows the fake agent's rate around 0.8 (84 and 88 of 100 in
two runs).

| File | What it is |
|---|---|
| [`with-pass-rate.eval.ts`](./with-pass-rate.eval.ts) | The eval: five runs, a pass-rate gate and two checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The flaky fake agent, and the real agents from `../profiles.ts` |

Gates, pass@1 and pass^k are in the [Gates and lift](../../docs/concepts/lift.mdx) concept page.
