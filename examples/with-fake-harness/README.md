# with-fake-harness

**Shows:** a scripted agent for building and testing evals. `fakeHarness({ script })` takes one
list of steps per `c.send`: `exec` runs a real command in the sandbox, `write` edits files and
`reply` is the turn's final message. The eval sends two turns and checks each with
`toHaveEdited` and `toHaveRun`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs the scripted agent, with no keys or Docker. Its first turn
lists the files and writes the [`fake-agent/`](./fake-agent) fixture into the workspace; its
second runs the tests. `pnpm eval --profile claude-code` runs the same eval on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts), so the checks
you built against the script now check a real agent.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the turns in `pnpm eval -v`: each script step shows as a real agent's would.

```text
[adds#1 fake] 15:00:09 harness   turn 1 started: "Add a multiply(a, b) function to src/math.js, with a test."
[adds#1 fake] 15:00:09 harness   tool shell called: $ ls src test
[adds#1 fake] 15:00:09 harness   tool shell returned exit 0 in 3ms
[adds#1 fake] 15:00:09 harness   tool write src/math.js (modify)
[adds#1 fake] 15:00:09 harness   tool write test/math.test.js (modify)
…
[adds#1 fake] 15:00:10 harness   turn 2 started: "Now run the tests and tell me whether they pass."
[adds#1 fake] 15:00:10 harness   tool shell called: $ node --test
…
[adds#1 fake] 15:00:10 check     assert ✓ toHaveEdited src/math.js (toHaveEdited, pass)
[adds#1 fake] 15:00:10 check     assert ✓ toHaveRun /node --test|npm (test|t)\b/ (toHaveRun, pass)
```

| Option | What the fake agent does |
|---|---|
| `files`, `text` | Writes these files and replies with this message on every turn |
| `failWith` | Throws before the first turn, as an infra error (exit 3) |
| `delayMs` | Waits this long per turn, honouring timeouts and Ctrl-C |
| `flakeRate` | Writes nothing in this share of attempts |
| `{ mcp: 'server/tool' }`, `{ error }` | More script steps: call a stdio MCP server's tool, end the turn with an error |

| File | What it is |
|---|---|
| [`with-fake-harness.eval.ts`](./with-fake-harness.eval.ts) | The eval: two turns, three checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the scripted agent writes |
| [`reeval.config.ts`](./reeval.config.ts) | The script, and the real agents from `../profiles.ts` |

Every option and step is in the [fakeHarness()](../../docs/reference/harness/fake.mdx) reference.
