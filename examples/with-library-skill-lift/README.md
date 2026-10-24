# with-library-skill-lift

**Shows:** measuring a skill someone else publishes. The variant fetches the `api-conventions`
skill from its GitHub repository at a pinned commit with `skill.git(repo, { ref, path, only })`.
The compare has no baseline, so the eval's own environment is the control. The agent adds a
paginated `listUsers` handler, and a hidden test checks the skill's rules: cursor pages as
`{ data, nextCursor }` and a `400 invalid_cursor`.

**Needs:** the network, for reeval to fetch the skill on the host (it caches it in
`.reeval/cache/`); in this repo, run `pnpm install && pnpm build` at the root first. A real agent
needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker, and
`pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it writes the offset-paged handler in `plain/`, and the
cursor-paged one in `skill/` only when it's given the skill. `pnpm eval --profile claude-code` runs
the same compare on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result block's arms, and the hidden check that tells them apart:

```text
pass             pages the users list by the API conventions
  arm                          pass
  users-api                    0 of 4
  api-conventions              4 of 4  helped
  check                        users-api  api-conventions
  follows the API conventions  0 of 4     4 of 4
    expected command to succeed, exit code 1
  +1 more passed
```

The record pins what was measured: `pnpm reeval show latest --json` lists the skill's source,
commit and content hash under `environments[].skills`.

| File | What it is |
|---|---|
| [`with-library-skill-lift.eval.ts`](./with-library-skill-lift.eval.ts) | The eval: the control, the fetched skill as the variant, and two checks |
| [`checks/conventions.test.js`](./checks/conventions.test.js) | The hidden test of the skill's rules |
| [`project/`](./project) | The package the agent starts from: `src/users.js`, 45 users |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace, without and with the skill |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Skill sources (`skill.git`, `skill.npm`, `skill.registry`) are in the
[Helpers](../../docs/reference/helpers.mdx) reference.
