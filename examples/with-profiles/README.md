# with-profiles

**Shows:** cheap pull request runs and thorough nightlies from one config. The agent adds
`multiply(a, b)` to a small package; the config runs it twice, a `pr` profile caps it at once with
`limit` and a `budget`, and a `nightly` profile raises it to four with `defaults` and records the
run. `defaultProfile: { ci: 'pr' }` picks `pr` whenever `CI` is set.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).
One profile applies at a time, so `pr` and `nightly` size the fake agent's runs.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the plan under each profile. `--dry-run` runs nothing:

```bash
pnpm reeval run --dry-run
CI=1 pnpm reeval run --dry-run
pnpm reeval run --dry-run --profile nightly
```

```text
plan  run … · 1 eval · 1 cell · 2 attempts · ~2s serial (~1s at concurrency 4)
eval                                                     harnesses  variants  runs  attempts  notes
with-profiles.eval.ts › adds a tested multiply function  1          —         2     2
plan  run … · profile pr (auto: CI is set) · 1 eval · 1 cell · 1 attempt · ~1s serial · budget 10 attempts ✓
eval                                                     harnesses  variants  runs  attempts  notes
with-profiles.eval.ts › adds a tested multiply function  1          —         1     1         runs 2 → 1 (profile pr)
plan  run … · profile nightly (--profile) · 1 eval · 1 cell · 4 attempts · ~4s serial (~1s at concurrency 4) · budget 2h
eval                                                     harnesses  variants  runs  attempts  notes
with-profiles.eval.ts › adds a tested multiply function  1          —         4     4
```

The plan line says which profile applied and why, and the notes say what its `limit` changed.

| File | What it is |
|---|---|
| [`with-profiles.eval.ts`](./with-profiles.eval.ts) | The eval: one prompt, two checks, no `runs` of its own |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, `pr` and `nightly`, and the real agents from `../profiles.ts` |

Profiles, limits and budgets are in the [Size runs with profiles](../../docs/runs/profiles.mdx) page.
