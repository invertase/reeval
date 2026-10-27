# with-skill-sources

**Shows:** skills from everywhere reeval can take them: `skill.git` (a GitHub repository at a
commit, narrowed with `only`), `skill.registry` (a skills.sh id), `skill.npm` (a published
package's `skills/`) and `skill.inline` (written in the eval, placed in the workspace with
`placement: 'workspace'`). The agent lists the skills it has, and the eval checks each name is in
its reply.

**Needs:** the network, to fetch the skills from GitHub and the npm registry on the host; nothing
else for the fake agent. In this repo, run `pnpm install && pnpm build` at the root first. A real
agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker, and
`pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It replies with
[`fake-agent/reply.md`](./fake-agent/reply.md) to mimic what an agent would say, so the checks have
something to check; the skills are still fetched and placed for real. `pnpm eval --profile
claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** after a run, `env_skills` lists where each skill came from, the commit a git
or registry source resolved to, and where it was placed:

```bash
pnpm reeval query "SELECT name, source, commit_sha, placement FROM env_skills"
```

```text
name              source                                                        commit_sha                                placement
brand-guidelines  github:anthropics/skills#dbd4588f9e1033efb41dad4bef2f7947c8…  dbd4588f9e1033efb41dad4bef2f7947c8993d44  harness
doc-coauthoring   registry:anthropics/skills@doc-coauthoring#dbd4588f9e1033ef…  dbd4588f9e1033efb41dad4bef2f7947c8993d44  harness
eval-rubric       npm:reeval@0.13.0:skills                                      ·                                         harness
release-notes     inline                                                        ·                                         workspace
```

A git skill on a branch, or a registry skill without a `version`, warns in the plan.

| File | What it is |
|---|---|
| [`with-skill-sources.eval.ts`](./with-skill-sources.eval.ts) | The eval: one skill from each source, and a check per skill |
| [`fake-agent/reply.md`](./fake-agent/reply.md) | The fake agent's reply |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Every skill source and its options are in the [Environment helpers reference](../../docs/reference/environment-helpers.mdx)
reference.
