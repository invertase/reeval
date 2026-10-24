# with-compare-control

**Shows:** a compare without a `baseline`. The eval runs in its own `environment`, and
`compare: { variants: [withConventions] }` makes that environment the control, so you name only
the variant. The agent pages a small user list, and a hidden test checks it pages by cursor as
the `api-conventions` skill says.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it pages by offset without the skill and by cursor with it.
`pnpm eval --profile claude-code` runs the same compare on Claude Code, and `--profile <name>` on
any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the control's arm is named after the eval's environment, `users`:

```text
pass             pages the user list
  arm              pass
  users            0 of 1
  api-conventions  1 of 1  can't tell yet
  check            users   api-conventions
  pages by cursor  0 of 1  1 of 1
    expected command to succeed, exit code 1
```

The run record says where the control came from: `evals[].compare` is
`{ "baseline": "users", "from": "environment" }`. One try a side can't give a verdict;
`pnpm eval --runs 4` can.

| File | What it is |
|---|---|
| [`with-compare-control.eval.ts`](./with-compare-control.eval.ts) | The eval: its environment, the variant and a hidden test |
| [`skills/api-conventions/SKILL.md`](./skills/api-conventions/SKILL.md) | The skill under test |
| [`project/`](./project) | The package the agent starts from: `src/users.js` |
| [`hidden/users.test.js`](./hidden/users.test.js) | The test the eval writes after the turn, which the agent never sees |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace, without and with the skill |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

[Leave out the baseline](../../docs/guide/compare.mdx#leave-out-the-baseline) in the Compare and
lift guide covers where the control comes from.
