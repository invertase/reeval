# with-multi-turn

**Shows:** a session with a follow-up turn, checked turn by turn. The agent adds `multiply(a, b)`,
then a second `c.send` asks it to take any number of arguments. Checks before the second `c.send`
see the workspace as the first turn left it; checks after it see the final state. Each turn's
`Turn` has its own transcript, so `expect(first).toHaveEdited(…)` reads only that turn.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check: `turn-1/` on the first turn and `turn-2/` on the second.
`pnpm eval --profile claude-code` runs the same eval on Claude Code, and `--profile <name>` on any
other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval --log-order grouped --output-logs full`. Each check runs between
the turns it follows:

```text
[extends#1 fake]  +0:00 turn 1 done 1ms · 0 tool calls, 2 file edits
[extends#1 fake]  +0:00 $ node ~/checks/call.mjs multiply 2 3  exit 0 27ms
[extends#1 fake]  +0:00 turn 2 done 1ms · 0 tool calls, 2 file edits
[extends#1 fake]  +0:00 $ node ~/checks/call.mjs multiply 2 3 4  exit 0 22ms
[extends#1 fake]  +0:00 $ node ~/checks/call.mjs multiply 2 3  exit 0 25ms
[extends#1 fake]  +0:00 $ node --test  exit 0 73ms
```

A failed check after the first turn stops the attempt before the second is sent, here with the
fake agent's first `multiply` adding instead:

```text
fail             extends multiply in a follow-up turn
  turn 1: multiply(2, 3)  failed
    expected '5' to be '6' // Object.is equality
  +1 more passed
```

| File | What it is |
|---|---|
| [`with-multi-turn.eval.ts`](./with-multi-turn.eval.ts) | The eval: two turns, with checks after each |
| [`checks/call.mjs`](./checks/call.mjs) | Prints a `src/math.js` function's result; placed in the sandbox's home, outside the workspace |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent writes on each turn |
| [`reeval.config.ts`](./reeval.config.ts) | The scripted fake agent, and the real agents from `../profiles.ts` |

Turns, `c.turns` and each turn's diff are in the [Read each turn](../../docs/write/turns.mdx)
guide.
