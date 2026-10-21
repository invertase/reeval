---
name: quick-start
description: >
  Get someone up and running with reeval, the eval runner for coding agents: detect what's set
  up, install it, write one to three small evals that show its value (a skill with and without,
  when the project has skills), check the keys and Docker with `reeval doctor`, and explain the
  results. Use when asked to "set up reeval", "add evals", "try reeval" or "get started with
  reeval", in an existing project or an empty directory.
---

# reeval quick start

Your job is the user's first good run: a few small evals that pass `--dry-run`, the keys and
Docker sorted, and a short explanation of what the evals show. Small and readable beats complete.
For the authoring API in depth, the reeval skill (`skills/reeval/SKILL.md` in
github.com/invertase/reeval) has it; this file has everything a first setup needs.

Rules that hold throughout:

- **Never overwrite or re-initialise.** Don't run `reeval init` where a `reeval.config.*` or
  `reeval.yaml` exists, never pass `--force`, never edit or delete an existing eval, and add new
  files beside the user's.
- **Never write, print or ask for a key's value.** Name the variable and the file it goes in.
- **Ask before you build,** then stop and wait (step 2). If the user's message already answers
  the question, don't ask it again.

## 1. Look before you touch anything

```bash
ls -a; ls reeval.config.* reeval.yaml evals 2>/dev/null
grep -n '"reeval"' package.json 2>/dev/null
ls pnpm-lock.yaml yarn.lock bun.lock package-lock.json 2>/dev/null   # the package manager
find . -name SKILL.md -not -path '*/node_modules/*' | head -20       # the project's skills
ls AGENTS.md CLAUDE.md .mcp.json .cursor/mcp.json docs 2>/dev/null
grep -o '^[A-Z_]*=' .env.local .env 2>/dev/null                      # key names only
```

| You find | State | Then |
|---|---|---|
| A `reeval.config.*` or `reeval.yaml` | Set up | No init. Read the config and the evals, run `npx reeval run --dry-run`, add only what's missing |
| `reeval` in `package.json`, no config | Installed | `npx reeval init --bare --harness <h>` |
| Neither | New | Install, then `init --bare` (step 3) |

The directory is a **project** if it has code, docs or skills (`package.json`, `src/`,
`README.md`, `skills/`, a `.git` with commits); it's **empty** if there's nothing but dotfiles.

## 2. Agree what to evaluate

**In a project,** say in two or three sentences what you found and what you propose, then ask
and stop. For example: "This repo has two skills. I'd set up reeval with one eval that runs Cursor
on a Postgres task with and without `supabase-postgres-best-practices`, to show what the skill
changes. Shall I set up evals for this project?"

**In an empty directory, or when the user says no,** ask what they want to evaluate (an SDK, an
API, a library, docs or a skill they're writing, a kind of task) and stop. When they answer,
research it before you write a line: read its docs, changelog and README (search the web, fetch
the pages), note the current version, and find a few things a coding agent gets wrong without
help: a renamed API, a new default, a required option, a convention. Those are your evals.

## 3. Install and initialise

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
already: that's your cue to stop initialising, not to `--force`. The config sets
`analysis.model` for insights (needs `GOOGLE_GENERATIVE_AI_API_KEY`) and `pr` and `nightly`
profiles. Leave them.

## 4. Write one to three evals

Pick the low-hanging fruit, in this order:

1. **The project has skills:** a compare of one skill, with and without. The control is an empty
   workspace, the variant the same plus the skill; the task is one the skill's own rules decide.
   This is the eval that shows lift. Template A in
   [references/templates.md](references/templates.md).
2. **The project is a library, SDK or API:** the agent uses it for a small task, checked by
   running the result. Template B.
3. **An empty directory:** the researched subject, a compare of a short skill or doc you write
   from the research (`skills/<subject>/SKILL.md`) against none, or a single eval. Template C.

Each eval:

- **One task, one prompt, that doesn't name the answer.** Ask for the outcome ("a migration with
  customers and orders"), not the rule the skill teaches ("index the foreign key").
- **Deterministic checks first:** a file's content, a command's exit code, a script that imports
  the agent's code. Label each requirement with `expect.soft(x, 'label')`. Add a judge
  (`c.judge`) only for what no check can see, and then add `judge:` to the config.
- **A name that states the question:** `indexes foreign keys with the Postgres skill`, not
  `postgres test`. Insights read the name first.
- **Small:** `runs: 2` on a compare (4 attempts), 1 elsewhere. Seed only the files the task
  needs. If it needs the repo, seed it with `directory('..', { glob: ['!.env*', '!.reeval/',
  '!evals/'] })`: `directory()` doesn't skip `.env*`, and keys must not reach the sandbox.
- **Eval files go in `evals/*.eval.ts`,** environments in `evals/environments.ts`. Paths in
  `skill.local()`, `file()` and `directory()` are relative to the file that calls them.

Add a **canary** profile when a check is a regex or a script you wrote: a fake agent that does the
task wrong must fail every check, so you know the checks check (Template A shows one).

## 5. Check it plans, then the machine

```bash
npx reeval run --dry-run        # exit 0; the evals, cells and attempts you meant
npx reeval doctor               # Docker, image, keys; exit 1 names each fix
```

- Rerun `--dry-run` after every edit. Exit 2 is a config or eval mistake with a precise
  message; fix it, don't work around it. Check the counts: a compare is 2 cells.
- `doctor` lists each missing key as `fix: add NAME=... to .env.local`. Tell the user exactly
  those lines, and that `.env.local` goes next to `reeval.config.ts` (it's gitignored). The
  analysis key is a warning only: runs pass or fail the same without insights.
- No Docker, or `doctor` says the image isn't built: the user installs or starts Docker, then
  runs `npx reeval image build` once (minutes, cached).
- With Docker and a canary profile: `npx reeval run --profile canary --no-insights` must exit 1
  with every eval failing. Needs no keys. A canary that passes means a check isn't checking.

Only start a real `npx reeval run` if the user asked for it or agrees: it runs a real agent on
their key. One compare at `runs: 2` on Cursor is a few minutes.

## 6. Hand over

End with a short message, not a report:

1. What you added, one line per file, and what each eval asks.
2. What's missing, as commands: the `.env.local` lines, `npx reeval image build`, Docker.
3. The command to run: `npx reeval run` (or `npx reeval run <eval-name>` for one).
4. How to read the output, in a few lines:

```text
pass             indexes foreign keys with the Postgres skill
  arm                  pass
  plain                0 of 2
  with-postgres-skill  2 of 2  can't tell yet
  check                       plain   with-postgres-skill
  indexes orders.customer_id  0 of 2  2 of 2
```

- Each arm's `N of M` is passing attempts. The variant's word is its effect against the control:
  `helped`, `made it worse`, or `can't tell yet`, which it always is below 4 runs a side
  (`--runs 4` to find out). The check table shows which check told the arms apart.
- The sentences under a block are insights (`analysis.model`): they explain, never change a
  verdict. `Remarks:` after the tally names an eval that needs work, with the line to fix.
- Exit 0 means every gated cell passed; only the variant is gated in a compare.
- Details: `.reeval/runs/<run>/summary.md`, each attempt's `transcript.jsonl` and `diff.patch`;
  `npx reeval studio` browses them; `npx reeval query effort` compares tools, time and tokens.
