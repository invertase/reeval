# with-skill-reads

**Shows:** whether the agent opened the skill you gave it, and which of its files. The agent adds
`multiply(a, b)` with a `jsdoc` skill whose `SKILL.md` points to `references/tags.md`. After the
run, `reeval query` answers from the transcript: `skill_files` counts the reads of each file the
skill placed, `skill_reads` finds the first read, and `context_use` classes every tool call.

**Needs:** Docker, even for the fake agent, and `pnpm reeval image build` once; in this repo, run
`pnpm install && pnpm build` at the root first. A real agent needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code) and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent in Docker, with no keys. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; before that, one shell step reads the skill's `SKILL.md` and
not its reference. `pnpm eval --profile claude-code` runs the same eval on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the queries after the run. reeval lists the skill's files
only in Docker, which is why this example runs there.

```bash
pnpm reeval query "SELECT path, reads, first_line FROM skill_files"
```

```text
path                                       reads  first_line
~/.agents/skills/jsdoc/SKILL.md            1      4
~/.agents/skills/jsdoc/references/tags.md  0      ·
```

The reference was never opened. `first_line` is the read's line in the attempt's
`transcript.jsonl`, and `skill_reads` and `context_use` say the same from the skill's side and
the tool calls':

```bash
pnpm reeval query "SELECT skill, placement, read_line, reads FROM skill_reads"
pnpm reeval query "SELECT class, calls, example FROM context_use"
```

```text
skill  placement  read_line  reads
jsdoc  harness    4          1

class    calls  example
context  1      cat ~/.agents/skills/jsdoc/SKILL.md
```

| File | What it is |
|---|---|
| [`with-skill-reads.eval.ts`](./with-skill-reads.eval.ts) | The eval: an environment with the skill, and one check |
| [`skills/jsdoc/`](./skills/jsdoc) | The skill: `SKILL.md` and `references/tags.md` |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent in Docker, and the real agents from `../profiles.ts` |

The `reeval query` [Query views](../../docs/reference/query.mdx#views) reference has every column of
`skill_files`, `skill_reads` and `context_use`.
