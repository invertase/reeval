# with-skill

**Shows:** placing a skill and checking the agent used it. The environment gives the agent a
`jsdoc` skill with `skill.local`; the agent adds `multiply(a, b)` to a small package, and the eval
checks it read the skill with `toHaveCalledSkill` and wrote the JSDoc comment the skill asks for.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; first it reads the skill's `SKILL.md` with a shell command, as an
agent would. `pnpm eval --profile claude-code` runs the same eval on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts). Each agent gets
the skill where it reads skills.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** after a run, `skill_reads` says which skill each attempt opened, where it was
placed and how often it was read:

```bash
pnpm reeval query "SELECT skill, placement, reads FROM skill_reads"
```

```text
skill  placement  reads
jsdoc  harness    1
```

| File | What it is |
|---|---|
| [`with-skill.eval.ts`](./with-skill.eval.ts) | The eval: the environment with the skill, and three checks |
| [`skills/jsdoc/SKILL.md`](./skills/jsdoc/SKILL.md) | The skill the agent gets |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Skills and the other parts of an environment are in the
[Define an environment](../../docs/environments/index.mdx) page.
