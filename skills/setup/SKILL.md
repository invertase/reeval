---
name: setup
description: >
  Read this first, before the reeval skill, whenever you're asked to set up, install, add,
  try or get started with reeval (the eval runner for coding agents), in a project or an empty
  directory, including "set up reeval here" and "add evals". It detects what's set up, asks what
  to evaluate, installs reeval, writes one to three small evals that show its value (a skill with
  and without, when the project has skills), runs `reeval doctor` for keys and Docker, and
  explains the results.
---

# Set up reeval

Your job is the user's first good run: a few small evals that pass `--dry-run`, the keys and
Docker sorted, and a short explanation of what the evals show. Small and readable beats complete.
For the authoring API in depth, the reeval skill (`skills/reeval/SKILL.md` in
github.com/invertase/reeval) has it; this file has everything a first setup needs.

Rules that hold throughout:

- **Never overwrite or re-initialize.** Don't run `reeval init` where a `reeval.config.*` or
  `reeval.yaml` exists, never pass `--force`, never edit or delete an existing eval, and add new
  files beside the user's.
- **Never write, print or ask for a key's value.** Name the variable and the file it goes in.
- **Ask before you build,** then stop and wait (step 2): always, even when reeval is half set
  up or the right eval looks obvious. Only a message that already says what to evaluate
  ("add an eval for the postgres skill") skips the question.

## 1. Look before you touch anything

```bash
ls -a; ls reeval.config.* reeval.yaml evals 2>/dev/null
grep -n '"reeval"' package.json 2>/dev/null
ls pnpm-lock.yaml yarn.lock bun.lock package-lock.json 2>/dev/null   # the package manager
find . -name SKILL.md -not -path '*/node_modules/*' | head -20       # the project's skills
ls AGENTS.md CLAUDE.md GEMINI.md .cursor/rules .github/copilot-instructions.md 2>/dev/null  # rules
ls CONTRIBUTING.md .mcp.json .cursor/mcp.json docs 2>/dev/null
grep -o '^[A-Z_]*=' .env.local .env 2>/dev/null                      # key names only
```

| You find | State | Then |
|---|---|---|
| A `reeval.config.*` or `reeval.yaml` | Set up | No init. Read the config and the evals and run `npx reeval run --dry-run`; after step 2, add evals beside them |
| `reeval` in `package.json`, no config | Installed | `npx reeval init --bare --harness <h>` |
| Neither | New | Install, then `init --bare` (step 3) |

The directory is a **project** if it has code, docs or skills (`package.json`, `src/`,
`README.md`, `skills/`, a `.git` with commits); it's **empty** if there's nothing but dotfiles.

## 2. Agree what to evaluate

"Set up reeval" says to set reeval up, not what to evaluate, so it doesn't answer this step,
however clear the choice looks from the repo. Your first reply is the proposal and the
question, with nothing installed or written yet: end your turn there and wait for the answer.

**In a project,** say in two or three sentences what you found and what you propose, then ask
and stop. For example: "This repo has two skills. I'd set up reeval with one eval that runs Cursor
on a billing task with and without `acme-billing`, to show what the skill changes. Shall I set
up evals for this project?" With no skills, propose the rules file or a task in the code
instead.

**In an empty directory, or when the user says no,** ask what they want to evaluate (an SDK, an
API, a library, docs or a skill they're writing, a kind of task) and stop. When they answer,
research it before you write a line: read its docs, changelog and README (search the web, fetch
the pages), note the current version, and find a few things a coding agent gets wrong without
help: a renamed API, a new default, a required option, a convention. Those are your evals.

## 3. Install and initialize

Use the project's package manager (its lockfile), and pick the harness the user has a key for:

| Harness | `--harness` | Key |
|---|---|---|
| Cursor (default) | `cursor` | `CURSOR_API_KEY` |
| Claude Code | `claude-code` | `ANTHROPIC_API_KEY` |
| Codex | `codex` | `OPENAI_API_KEY` |
| Antigravity | `antigravity` | `GEMINI_API_KEY` |
| OpenCode, Goose, pi | `opencode`, `goose`, `pi` | `GOOGLE_GENERATIVE_AI_API_KEY` |

```bash
npm init -y                                  # only if there's no package.json
npm i -D reeval                              # pnpm add -D reeval · yarn add -D reeval
npx reeval init --bare --harness cursor      # pnpm reeval init … · yarn reeval init …
```

`--bare` writes only `reeval.config.ts`, the `.gitignore` entries (`.reeval/`, `.env*`) and the
`eval` script; it merges into existing files and skips the rest. It exits 2 if reeval is set up
already: that's your cue to stop initializing, not to `--force`. The config sets
`analysis.model` for `reeval analyze` (needs `GOOGLE_GENERATIVE_AI_API_KEY`) and `pr` and `nightly`
profiles. Leave them.

## 4. Write one to three evals

Pick the low-hanging fruit, in this order:

1. **The project has skills:** a compare of one skill, with and without. The control is an empty
   workspace, the variant the same plus the skill; the task is one the skill's own rules decide.
   This is the eval that shows lift. Template A in
   [references/templates.md](references/templates.md).
2. **No skills, but agent rules** (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`): a
   compare of the rules file, with and without, on a small task in the real repo. Template D.
3. **Any other codebase (an app, a CLI, a library):** a small task in the real repo, checked by
   its typecheck, its tests or a hidden test. Template B.
4. **An empty directory:** the researched subject, a compare of a short skill or doc you write
   from the research (`skills/<subject>/SKILL.md`) against none, or a single eval. Template C.

Work in the user's code, not a copy you make up: seed the repo with `directory('..')` rather
than stub files, which hand the agent the convention you meant to test. Don't write a skill or
rules from what you already know to compare against: your checks would restate what you wrote,
so the compare measures nothing. Write one only from research (step 2, Template C).

Each eval:

- **Check rules only the skill teaches.** Read the skill (or rules file) and pick two or three
  of its most specific rules that one task touches: a house convention, a helper or file it
  names, a version-specific API, a non-obvious default. Ask of each: would a strong agent do
  this unprompted? If yes (index a foreign key, deny public access, validate input), both arms
  pass it; pick another. In a real repo, the agent copies what the code around the change
  already shows (the error class, the logger), so prefer rules the code can't show: a changelog
  entry, where tests go, a file to register in. Grep the repo for each rule: one that
  `CONTRIBUTING.md` or the docs repeat reaches the control too, so leave those files out of
  the control as well, or pick another rule. Check that the task triggers each rule: a rule for
  user-facing changes needs a user-facing task. One labeled check per rule, so the check
  table shows which ones the skill changed.
- **One task, one prompt, that doesn't name the answer.** Ask for the outcome in the user's
  words ("an invoices table with its total"), never the rule the check looks for ("store the
  total in cents"), and not in the rule's terms either ("a user-visible fix" hints at the
  changelog). Reread the prompt: if it restates the rule, the control passes too. Name the
  file the task is about (`src/projectId.ts`) so a check can read it, but not the files a rule
  decides (where the test goes): check those with a glob or the one path the rule allows.
- **Deterministic checks first:** a file's content, a command's exit code, a script that imports
  the agent's code. Label each requirement with `expect(x, 'label')`; a failed one is recorded and the eval carries on. Add a judge
  (`c.judge`) only for what no check can see, with the inputs its question reads
  (`{ diff: ['src/**'] }`, `{ output: true }`), and then add `judge:` to the config.
- **A name that states the question:** `stores invoice totals in cents with the billing skill`,
  not `billing test`. The results and `reeval analyze` read in its terms.
- **Small:** leave `runs` unset: a compare runs 4 a cell (8 attempts), the fewest for a lift
  verdict, and anything else once. Seed only the files the task
  needs. If it needs the repo, seed it with `directory('..', { glob: ['!.env*', '!.reeval/',
  '!evals/', '!reeval.config.*'] })`: `directory()` doesn't skip `.env*`, keys must not reach
  the sandbox, and the agent must not read your checks or the oracle's answer in the config.
- **Eval files go in `evals/*.eval.ts`,** environments in `evals/environments.ts`. Paths in
  `skill.local()`, `file()` and `directory()` are relative to the file that calls them. If
  `evals/environments.ts` exists, append your environments below what's there and leave its
  lines, comments included, as they are.

When a check is a regex or a script you wrote, add two fake-agent profiles (Template A shows
both): a **canary** that does the task wrong must fail every check, so the checks check; an
**oracle** that does it right, written another way than you'd expect (another helper name,
another order, schema-qualified `public.notes`), must pass, so the checks don't demand one
spelling: a regex that wants `on notes (` fails the agent that writes `on public.notes (`. A
check that runs a build or the project's tests needs no oracle.

## 5. Check it plans, then the machine

```bash
npx reeval run --dry-run        # exit 0; the evals, cells and attempts you meant
npx reeval doctor               # Docker, image, keys; exit 1 names each fix
```

- Rerun `--dry-run` after every edit. Exit 2 is a config or eval mistake with a precise
  message; fix it, don't work around it. Check the counts: a compare is 2 cells.
- `doctor` lists each missing key as `fix: add NAME=... to .env.local`. Tell the user exactly
  those lines, and that `.env.local` goes next to `reeval.config.ts` (it's gitignored). The
  analysis key is a warning only: runs pass or fail the same without it.
- No Docker, or `doctor` says the image isn't built: the user installs or starts Docker, then
  runs `npx reeval image build` once (minutes, cached).
- With Docker: `npx reeval run --profile canary <eval-name>` must fail every
  check you wrote, and `--profile oracle` must pass them. Name the eval: a fake agent writes the
  same files for every eval, so it answers only the one it was written for. Needs no keys,
  seconds each. A canary that passes means a check isn't checking; an oracle that fails means a
  check is too narrow. Fix the check.

Only start a real `npx reeval run` if the user asked for it or agrees: it runs a real agent on
their key. One compare (8 attempts) on Cursor is several minutes.

## 6. Hand over

End with a short message, not a report:

1. What you added, one line per file, and what each eval asks.
2. Each key the config needs by name (`CURSOR_API_KEY`, the analysis key) and whether `doctor`
   found it; then what's missing, as commands: the `.env.local` lines, `npx reeval image
   build`, Docker.
3. The command to run: `npx reeval run` (or `npx reeval run <eval-name>` for one).
4. How to read the output, in a few lines. A real Cursor run of Template A:

```text
pass             stores invoice totals in cents with the billing skill
  We can't tell yet: with-billing-skill passed 2 of 2 tries, while plain failed 2 of 2 tries.
  arm                     pass
  plain                   0 of 2
  with-billing-skill      2 of 2  can't tell yet
  check                   plain   with-billing-skill
  total in integer cents  0 of 2  2 of 2
  a currency column       0 of 2  2 of 2
  +1 more passed
13s · 232k in (108k cached) · 3,026 out · results .reeval/runs/…/summary.md
1 pass
```

- Each arm's `N of M` is passing attempts. The variant's word is its effect against the control:
  `helped`, `made it worse`, or `can't tell yet`, which it always is below 4 runs a side
  (`--runs 4` to find out). The check table shows which check told the arms apart.
- `Remarks:` after the tally names an eval that needs work, with the line to fix. Remarks never
  change a verdict.
- Both arms passing is a result, not a broken eval: the agent already does this without the
  skill. Say so, and suggest a harder task or a more specific rule from the skill next.
- A check that fails every attempt on both arms is more often a broken check than a hard task.
  Open one attempt's `diff.patch` before you say the agent can't do it.
- Exit 0 means every gated cell passed; only the variant is gated in a compare.
- Details: `.reeval/runs/<run>/summary.md`, each attempt's `transcript.jsonl` and `diff.patch`;
  `npx reeval studio` browses them; `npx reeval query effort` compares tools, time and tokens.
