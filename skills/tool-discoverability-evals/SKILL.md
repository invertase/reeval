---
name: tool-discoverability-evals
description: >
  Write a reeval evaluation suite that measures whether coding agents choose a given library,
  SDK or tool, and whether they use it correctly once chosen. Use when asked about
  discoverability, which library an agent picks for a job, whether a tool is an agent's default
  stack, how a tool fares in a competitor comparison against named rivals, whether agents know
  a tool's real capabilities (capability check), whether the architecture agents recommend leads
  to the tool, or whether agents write working, current SDK syntax for it. Covers six case types
  (discovery, compound-job, validation, competitor, market perception, accuracy), each with a
  template loaded on demand. Not for installing or setting up reeval: use the setup skill first.
---

# Tool discoverability evaluations

A discoverability suite asks one question per case type: when a developer gives a coding agent
an ordinary request, does the agent reach for your tool, and does its code work? This skill
shapes that suite. It assumes reeval is installed and configured; if not, follow
[../setup/SKILL.md](../setup/SKILL.md) first. For the authoring API, follow
[../reeval/SKILL.md](../reeval/SKILL.md) and the docs it links.

## Procedure

1. **Pin the subject.** Write down the tool's package name and current version, the job it does
   in one phrase ("authentication for a web app"), and two or three named rivals. Research the
   tool's docs and changelog for what it really does and doesn't do.
2. **Write the reference.** Put the tool's real capabilities, limits and core pattern in
   `evals/discoverability/reference.md`: short factual lines, each with the version it holds
   for, including what the tool can't do. Validation and market perception cases hand it to the
   judge. It lives under `evals/`, which no environment seeds, so the agent never sees it.
3. **Pick the cases.** One file per type you need, under `evals/discoverability/`. Open the
   template only when you write that file:

   | Type | Measures | Template |
   |---|---|---|
   | Discovery | The tool is the default for its job, with nothing named | [references/discovery.md](references/discovery.md) |
   | Compound-job | The tool wins when the repo pins a stack and the prompt adds one constraint | [references/compound-job.md](references/compound-job.md) |
   | Validation | The agent states the tool's capabilities correctly | [references/validation.md](references/validation.md) |
   | Competitor | The agent picks the tool over a named rival in a real repo | [references/competitor.md](references/competitor.md) |
   | Market perception | The architecture the agent recommends leads to how the tool works | [references/market-perception.md](references/market-perception.md) |
   | Accuracy | Once chosen, the agent writes code that runs against the current SDK | [references/accuracy.md](references/accuracy.md) |

   Start with discovery and accuracy: they tell you whether agents find the tool and whether
   finding it helps. Add the others when the user asks about their question.
4. **Build the fixtures.** Shared environments go in `evals/environments.ts` (see
   [Environments](https://github.com/invertase/reeval/blob/main/docs/configuration/environments/index.mdx)).
   Each fixture is a small project of the right kind (`package.json`, a source file or two, a
   `.gitignore`) that states its stack the way a real repo does: in its manifest, config files
   and code, not in a note written to steer the agent.
5. **Write each case from its template,** swapping in the tool, the job, the rivals and the
   fixture. Use `evaluate.each` with six or more phrasings per type, so one prompt's wording
   doesn't decide the result (see
   [Evaluate many cases](https://github.com/invertase/reeval/blob/main/docs/evaluations/task/cases.mdx)).
6. **Share the suite's options.** Every template spreads `suite` into its options: the
   harnesses as a list, one cell per agent (see
   [Compare harnesses](https://github.com/invertase/reeval/blob/main/docs/evaluations/recipes/compare-harnesses.mdx)),
   four attempts a cell, and a tag that keeps the suite out of other runs.

   ```ts
   // evals/discoverability/suite.ts (not an eval file, so reeval doesn't load it)
   import { claudeCode, codex, cursor } from 'reeval/harness'

   export const suite = {
     harness: [
       cursor({ model: 'composer-2.5' }),
       claudeCode({ model: 'claude-sonnet-5' }),
       codex({ model: 'gpt-5.6-luna' }),
     ],
     runs: 4,
     tags: ['discoverability'],
   }
   ```
7. **Check it,** as the reeval skill describes: `npx reeval run --dry-run`, then an oracle and a
   canary fake harness per deterministic check. Review names, prompts and judge questions
   against [../eval-rubric/SKILL.md](../eval-rubric/SKILL.md).

## Gotchas

- **The prompt names nothing it measures.** Discovery, compound-job and market perception
  prompts never name the tool, a rival or the tool's own vocabulary (its product terms, its
  config file name). Reread each prompt: if a phrase only makes sense for one tool, the case
  measures your wording.
- **The fixture leaks the answer.** A fixture that already depends on the tool or a rival, or
  has its config file, a lockfile entry or an import of it, answers discovery for the agent.
  Seed only the stack the case pins; for competitor cases, seed the repo state both tools must
  fit, not one tool half-installed.
- **Check the dependency, not the prose, when the agent builds.** When the prompt asks for
  work, the agent's choice is the package it installs:
  `toHaveFile('package.json', /"tool-name"/)`. Use a judge only when the prompt asks for advice
  and the answer is prose.
- **A judge question must fail the wrong reply.** "Is acme-auth the library the reply
  recommends first?", not "Does the reply mention acme-auth?": a reply that lists five options
  mentions it and recommends another.
- **The judge doesn't know your tool.** It answers from its own training, which may be older
  than your release. For any question about what the tool does, pass the reference with
  `c.judge(q, { on: { reply: turn.text, reference } })`, and ask whether the reply agrees with
  the reference.
- **Validation needs no-cases.** Half the capability questions should ask for something the tool
  can't do, with the reference saying so. Otherwise an agent that answers "yes" to everything
  passes.
- **Competitor cases run both orders.** Name the tool first in half the cases and the rival
  first in the rest; agents lean to the first or last name they read.
- **A failure is a finding.** These cases measure a share of attempts, not a correctness bar.
  Keep them out of pull request gates (`--tag '!discoverability'` there,
  `--tag discoverability` on their own schedule), and read the per-harness rows, not just the
  exit code.
- **Accuracy pins the version.** The fixture's `package.json` pins the SDK version you
  researched and its `setup` installs it, so a typecheck against the installed types catches an
  invented method or flag. Without the pin, the agent installs whatever it remembers.
