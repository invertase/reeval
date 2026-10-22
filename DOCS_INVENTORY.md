# reeval Surface Area Inventory (Gate 1)

Source-verified inventory of `packages/reeval` (`0.12.0`), `packages/reeval-python`, and `scripts/docs.mjs` on `origin/main` (`fb4bc326`).

## 0. Gate 1 Decisions

**Rule:** product design decides what is Public. `scripts/docs.mjs` and `scripts/harness-matrix.mjs` are linters. When a check enforces something that is excluded, Phase 2 changes the script (an ignore list or a dropped column), and the docs don't grow to satisfy it. The last column lists each change. Line numbers are on `origin/main` (`fb4bc326`).

Ben's review (22 Oct 2026) is recorded below. This section supersedes the Status columns in sections 1–6, which are unchanged. Rows marked **Flag** have a fact for Ben to reconfirm before Phase 2.

### Feature areas

| # | Feature (plain English) | Decision | Public | Excluded | Script change for Phase 2 |
|---|---|---|---|---|---|
| 1 | **Coding agents** (harnesses) | Public, except `fx` and `fakeHarness` | `cursor`, `claudeCode`, `codex`, `antigravity`, `opencode`, `goose`, `pi`, `grokBuild` | `fx`; OpenCode's table of 22 refused providers; `fakeHarness`, an internal mock helper like every `fake*` symbol | `harness-matrix.mjs`: skip excluded kinds in the page check (`:195-197`) and the matrix and layout rows (`:188-224`), and drop the fx notes (`:151-161`). `docs.mjs`: stop generating `opencode-refused` (`:373`). Delete `reference/harness/fx.mdx` with its sidebar link (`docs.mjs:494-504`). `fakeHarness` needs no script change: it isn't in `AGENTS`, and its contract row is skipped (`harness-matrix.mjs:226`). Delete `reference/harness/fake.mdx` and the recipe built on the fakes, `recipes/fake-harness.mdx`, with their sidebar links (`docs.json:189`, `:140`). OpenCode's refusal error states its own reason (`packages/harness-opencode/src/opencode-providers.ts:99`). **Flag:** the question mark on fx's status in Section 1 was the inventory's guess, not a product state. fx on OpenAI is a contract row the real tier runs (`test/support/harnesses.ts:286`); only fx on AI Gateway is gated, for want of a repository secret (`:306-309`) |
| 2 | **Sandboxes** | Public, except `fakeSandbox()` | `docker()`, `podman()` | `fakeSandbox()`, an internal mock helper like every `fake*` symbol | None: no check names it. Delete `reference/sandbox/fake.mdx` with its sidebar link (`docs.json:198`). The refusal a real harness gives outside Docker still suggests `fakeHarness()` with `fakeSandbox()` (`src/harness/agent.ts:146`); `harness-matrix.mjs:183-188` checks only its first clause |
| 3 | **What the agent gets: skills, MCP servers and rules** | Public | `skills` / `skill.*`, `mcp` / `mcp.*`, `rules`, `files`, `setup`, `workspace` / `git` | — | None |
| 4 | **What the agent gets: plugins** | Exclude, unless plugins become a v1 workflow | — | `plugins`, `plugin.{local,git,npm,marketplace}`, `PluginPart`, `build` | `harness-matrix.mjs`: drop the Plugins column (`:264`, `:279`) and the four plugin notes (`:76-104`). `docs.mjs`: drop `PluginRecord` from `RECORD_TYPES` (`:264`), and skip `EnvironmentRecord`'s `plugins` field (`src/types.ts:2055-2056`), which `record-types` renders otherwise. The contract-row plugin check (`harness-matrix.mjs:215-219`) only compares code and stays |
| 5 | **Checking the running app** | Public | `c.serve`, `c.capture`, the `capture` option, `artifacts` on `c.judge` / `question` | — | None |
| 6 | **Comparing two setups** | Public | `compare` (`baseline`, `variants`, `gate`, `minLift`, `harness`, `questions`, `across`), the `question` option, the `question_pairs` view | — | None |
| 7 | **The run's written summary and eval warnings** | Public outcome, internal taxonomy excluded | `reeval analyze`, the `analysis` config, what `Remarks:` lines mean | Remark kind ids (`name-contradicts`, `judge-too-loose`, …; `src/remarks/rules.ts`). The terminal prints the sentence, not the id (`src/ui/remarks.ts:52`) | None: kind ids aren't in any generated block |
| 8 | **Bug-report bundle** | Public, CLI reference only | `reeval report` in the CLI reference (`cli-help:report`) | A guide page | None |
| 9 | **Overriding a score by hand** | Exclude | — | `reeval override` (not on main) | None: not in `src/cli-spec.ts` |
| 10 | **Evals in other languages, YAML config and test helpers** | Exclude | — | `*.eval.py` / `reeval-python`, `reeval.yaml` / `reeval.yml`, `reeval/testing` (`fakeInstructions`, an internal mock helper like every `fake*` symbol, and `declareTree`) | `docs.mjs`: add `REEVAL_PYTHON`, `REEVAL_PYTHON_SDK`, `REEVAL_RUNNER`, `REEVAL_RUNNER_TOKEN` and `REEVAL_PROJECT_ROOT` to the ignore list in `reevalVariables` (`:101-116`), beside `REEVAL_BASE_ARG` and `REEVAL_PYTHON_MODULE`. The `include` `<Property>` stays; its real default also matches `evals/**/*.eval.py` |
| 11 | **The saved results file**, and reading it from code | Record Public, `reeval/view` excluded | `RunRecord` and the `record-types` / `record-values` blocks, `reeval query`, `reeval show --json` | `reeval/view` helpers (`suiteResult`, `runHeader`, `readableRecord`, …), the studio's plumbing | None |
| 12 | **Agent skills for setting up reeval and writing evals** | Public: users install them into their own coding agent, and the setup skill has the agent run the documented commands (`reeval init --bare --harness <h>`, `reeval run --dry-run`, `reeval doctor`) | `npx skills add https://github.com/invertase/reeval --skill setup` (or `npx skills add invertase/reeval`) installs the `setup` skill (`skills/setup/SKILL.md` and `skills/setup/references/templates.md`): it detects what is set up, asks what to evaluate, installs reeval, writes one to three small evals and explains the results. It builds on the `reeval` skill (`skills/reeval/SKILL.md`) for the authoring API | `.agents/skills/add-a-language`, a maintainer skill for adding an eval language runtime, which is internal like the excluded `*.eval.py` runtime | None: no check reads `skills/`. **Flag:** added after Gate 1 from Ben's skills.sh link; the skill landed on `origin/main` in `a8398c96` (#464), after this inventory's `fb4bc326`. skills.sh lists only `setup` (`skills.sh/invertase/reeval`); its page for the `reeval` skill says it "isn't available in this repository". Ben's no-agent-page decision (Gate 2) gives the skills no page of their own, so where the install line appears is a Gate 2 call |

### Further exclusions from sections 1–6

| Item | Decision | Script change for Phase 2 |
|---|---|---|
| **Fake judge and fake analysis** (`fakeJudge`, `fakeAnalysis` in `reeval/judge`) | Exclude: internal mock helpers, like every `fake*` symbol | None |
| **Judge defaults as constants** (`RECOMMENDED_JUDGE_MODEL`, `DEFAULT_THRESHOLD`) | Exclude as imports; document `'typesafe-ai/jev-1.14.0'` and `0.8` as the `judge` defaults | None |
| **Skill and directory default ignores** (`DEFAULT_SKILL_EXCLUDE`, `DEFAULT_DIRECTORY_IGNORES`) | Exclude as imports; document their contents as the defaults of `skill.*` and `directory()`. Passing `exclude` replaces the list rather than adding to it | None |
| **Package-registry allowlist** (`DEFAULT_EGRESS_ALLOW`) | Exclude as an import. **Flag:** it isn't a default. `egress` defaults to `'allow-all'`, and this list applies only when spread into `{ allow: [...DEFAULT_EGRESS_ALLOW, 'api.example.com'] }` (`src/egress.ts:24-26`, `docs/reference/egress.mdx:9-13`), so documenting it as egress's default would be wrong. Proposed instead: keep it Public as the way to extend an allowlist, or print the seven hosts for copying | None |
| **Internal environment variables** (`REEVAL_BACKGROUND`, `REEVAL_FAKE_EXEC`, `REEVAL_PROJECT_ROOT`, `REEVAL_PYTHON`, `REEVAL_PYTHON_SDK`, `REEVAL_RUNNER`, `REEVAL_RUNNER_TOKEN`) | Exclude: reeval sets them in its own child processes and never reads them from your shell | `docs.mjs`: the same ignore list in `reevalVariables` (`:101-116`) |
| **Terminal layout names** (`results`, `choose`, `measure`, `harnesses`, `both`, `regressions` in `src/ui/layout.ts`) | Exclude; document the verdict words (`pass`, `fail`, `not gated`, …) and effect words (`helped`, `made it worse`, `can't tell yet`) | None: not checked |
| **Query storage tables** (the 17 `DATA_TABLES`) | Reference only, as one schema block; the 17 `reeval query` views are Public | None: `query-tables` stays one generated block (`docs.mjs:307`) |

### What the linters check today

Phase 2 edits these rules where a row above says so; everything else holds as written.

| Check | Requirement | Where |
|---|---|---|
| Harness pages | `docs/reference/harness/<kind>.mdx` for every key in `AGENTS` | `harness-matrix.mjs:195-197` |
| Generated blocks | Every generated block (each `cli-help:<command>` and `cli-help:footer`, `query-views`, `query-tables`, `exit-codes`, `option-keys`, `record-types`, `record-values`, `harness-matrix`, `harness-layout`, `opencode-providers`, `opencode-refused`) is used once on some `.mdx`, with no fixed page. An unknown block name fails | `docs.mjs:291-375`, `:403-405`, `:414-416` |
| Option keys | A `<Property name="<key>">` for every key in `CONFIG_KEYS` ∪ `EVAL_OPTION_KEYS`, on `reference/options`, `reference/config` or `reference/profiles` | `docs.mjs:444-457` |
| Profile keys | Every key in `PROFILE_KEYS` and `LIMIT_KEYS`, in backticks, on `reference/profiles` | `docs.mjs:458-465` |
| Environment variables | Every `REEVAL_*` in `src/` (except `REEVAL_BASE_ARG` and `REEVAL_PYTHON_MODULE`), in backticks, on `reference/env-vars` | `docs.mjs:101-116`, `:467-471` |
| Exit codes | A `\| <code> \|` row for each `EXIT` code on `reference/cli` | `docs.mjs:473-477` |
| Sidebar | Every `docs.json` sidebar link has a page, and every `.mdx` is in the sidebar, so an excluded page is deleted with its link | `docs.mjs:481-496`, `:503-504` |
| Package name | No page installs or imports the package by name; pages use `{{ pkg }}` | `docs.mjs:498-509` |

---

## 1. Package Entrypoints & Exported Functions / Types

### `reeval` (`packages/reeval/src/index.ts`)

| Symbol | Signature / Purpose | Status |
|---|---|---|
| `defineConfig` | `defineConfig(config \| ((helpers: ConfigHelpers) => ReevalConfig))` | Public |
| `defineEnvironment` | `defineEnvironment(name, spec \| ((helpers: EnvironmentHelpers) => EnvironmentSpec))` | Public |
| `evaluate` | `evaluate(name, [options], fn)` + `.skip`, `.only`, `.todo(name)` | Public |
| `evaluate.each` | `evaluate.each(cases, { pool?: boolean }?)(nameTemplate, [options], fn)` (`$key`, `%s`, `%#`) | Public |
| `group` | `group(name, [options], fn)` + `.skip`, `.only`, `.todo(name)` | Public |
| `expect` | Standalone `@vitest/expect` + reeval matchers, `.soft`, `.poll`, `.not` | Public |
| `DEFAULT_EGRESS_ALLOW` | `readonly string[]` (`registry.npmjs.org`, `registry.yarnpkg.com`, `github.com`, `*.github.com`, `*.githubusercontent.com`, `pypi.org`, `files.pythonhosted.org`) | Public |
| `DEFAULT_DIRECTORY_IGNORES` | `readonly string[]` (`node_modules/`, `dist/`, `.next/`, `.venv/`, `target/`, etc.) | Public |
| `DEFAULT_SKILL_EXCLUDE` | `readonly string[]` (`['/evals/', '.history/', '*.eval.ts']`) | Public |
| `HarnessCapabilityError` | Thrown when a harness cannot report a checked event (`web-search` / `web-fetch`) | Public |
| `AttemptContext` (`c`) | `c.send(prompt)`, `c.exec(cmd, { background? })`, `c.serve(cmd, port?)`, `c.capture(target, opts?)`, `c.judge(question, opts?)`, `c.readFile(path)`, `c.writeFile(path, data)`, `c.turns`, `c.signal`, `c.attempt` (`{ id, cell, n }`) | Public |
| `Turn` (`turn`) | `prompt`, `text`, `status`, `startedAt`, `durationMs`, `transcript`, `usage`, `model`, `unreported`, `diff`, `turn.exec(cmd)`, `turn.readFile(path)` | Public |
| Authoring & Record Types | `ReevalConfig`, `Profile`, `ProfileDefaults`, `ProfileLimit`, `Budget`, `HistoryConfig`, `Environment`, `EnvironmentSpec`, `EnvironmentHelpers`, `ConfigHelpers`, `EvalOptions`, `GroupOptions`, `EachOptions`, `CompareOptions`, `CompareQuestion`, `JudgeOptions`, `JudgeCallOptions`, `JudgeStateOptions`, `CaptureOptions`, `CaptureCall`, `Capture`, `Verdict`, `JudgeFailure`, `ExecResult`, `ServeHandle`, `BackgroundHandle`, `RunRecord`, `EvalEntry`, `CellRecord`, `AttemptRecord`, `FamilyRecord`, etc. | Public |

### `reeval/harness` (`packages/reeval/src/harness.ts`)

All real harnesses accept `{ model, effort?, id?, maxConcurrent?, startTimeout? }` (except `fx` which omits `effort`, and `cursor` which adds `params?: Record<string, string>`) and require `docker()` / `podman()`.

| Factory | Key / Brokered Host(s) | Capabilities (Rules / Skills / MCP / Plugins / Usage / Web) | Status |
|---|---|---|---|
| `cursor` | `CURSOR_API_KEY` → `api2.cursor.sh`, `*.cursor.sh` | `AGENTS.md`; `.cursor/skills` & `~/.agents/skills`; MCP `stdio`/`http`/`sse`; all plugin parts (flat unpack); tokens ✓; web ✓ (recovered) | Public |
| `claudeCode` | `ANTHROPIC_API_KEY` → `api.anthropic.com` | `CLAUDE.md`; `.claude/skills` & `~/.claude/skills`; MCP `stdio`/`http`/`sse`; plugins all except `rules` (namespaced); `effort`: `'low'\|'medium'\|'high'\|'xhigh'\|'max'`; tokens ✓; web ✓ | Public |
| `antigravity` | `GEMINI_API_KEY` → `generativelanguage.googleapis.com` | `AGENTS.md`; `.agents/skills` & `~/.gemini/config/skills`; MCP `stdio`/`http`/`sse`; all plugin parts (`agy plugin install`); tokens ✓; web ✗ | Public |
| `opencode` | `<provider>/<model>` key (122 supported in `OPENCODE_PROVIDERS`, 22 refused in `REFUSED_OPENCODE_PROVIDERS`) | `AGENTS.md`; `.opencode/skills` & `~/.config/opencode/skills`; MCP `stdio`/`http` (no `sse`); plugins `skills, agents, commands, mcp`; tokens ✓; web ✓ (`mcp.exa.ai`) | Public |
| `goose` | `GOOGLE_GENERATIVE_AI_API_KEY` → `generativelanguage.googleapis.com` | `AGENTS.md`; `.goose/skills` & private home; MCP `stdio`/`http` (no `sse`); plugins `skills, mcp`; tokens ✗ (ACP last-call only); web ✗ | Public |
| `pi` | `GOOGLE_GENERATIVE_AI_API_KEY` → `generativelanguage.googleapis.com` | `AGENTS.md`; `.pi/skills` & `~/.pi/agent/skills`; MCP `stdio`/`http` (no `sse`); plugins `skills, commands, mcp`; tokens ✓; web ✗ | Public |
| `codex` | `OPENAI_API_KEY` → `api.openai.com` | `AGENTS.md`; `.agents/skills` & `~/.agents/skills`; MCP `stdio`/`http` (no `sse`); plugins `skills, mcp` (refuses ChatGPT apps); tokens ✓; web ✓ | Public |
| `fx` | `AI_GATEWAY_API_KEY` (`<provider>/<model>`) or `OPENAI_API_KEY` (bare id) | `AGENTS.md`; `.fx/skills` & private home; MCP `stdio`/`http`/`sse` (HTTP/SSE bypass relay); plugins `skills, mcp`; no `effort`; tokens ✓; web ✓ | Experimental? |
| `grokBuild` | `XAI_API_KEY` → `api.x.ai` | `AGENTS.md`; `.grok/skills` & private home; MCP `stdio`/`http`/`sse`; plugins all except `rules` (namespaced); tokens ✓; web ✓ | Public |
| `fakeHarness` | None (`id?`, `files?`, `text?`, `delayMs?`, `ignoreAbort?`, `failWith?`, `startHangs?`, `reasoning?`, `servedModel?`, `effort?`, `tools?`, `withSkill?`, `flakeRate?`, `script?`, `layout?`) | Simulates any agent layout for dry runs and tests | Public |

### `reeval/sandbox` (`packages/reeval/src/sandbox.ts`)

| Factory | Options & Behaviour | Status |
|---|---|---|
| `docker(options?)` | `{ id?, image?, from?, dockerfile?, install?, maxConcurrent?, root?, capabilities?, memory?: '4g', swap?, cpus?: 2, pids?: 1024 }`. One base recipe (`image` \| `from` \| `dockerfile`); `install` cannot combine with `dockerfile`. `from` / non-`REEVAL_BASE` `dockerfile` require Debian/Ubuntu (`apt-get` + glibc). Enforces `'allow-all'`, `'deny-all'`, `{ allow }`. | Public |
| `podman(options?)` | Same `DockerOptions`, images, and egress gateway on `podman` CLI (requires Podman 4+, rootless bridge & cgroup v2 `cpu`/`memory`/`pids` controllers). | Public / Gate 1 |
| `fakeSandbox(options?)` | `{ id?, dir?: string \| URL, maxConcurrent? }`. Host temp directory; no isolation, no secret brokering, refuses restricted egress. | Public |

### `reeval/judge` (`packages/reeval/src/judge.ts`)

| Symbol | Signature / Value | Status |
|---|---|---|
| `RECOMMENDED_JUDGE_MODEL` | `'typesafe-ai/jev-1.14.0'` (also internal `RECOMMENDED_ANALYSIS_MODEL = 'google/gemini-3.8-flash'`) | Public |
| `DEFAULT_THRESHOLD` | `0.8` | Public |
| `fakeJudge` | `fakeJudge({ score?: number \| ((state: JudgeState) => number) })` (default `1`) | Public |
| `fakeAnalysis` | `fakeAnalysis({ output?, vote?, insights? })` | Public |

### `reeval/view` & `reeval/testing`

- `reeval/view`: Browser-safe view models (`suiteResult`, `runHeader`, `readableRecord`, `readableInsights`, `readableAnalysis`, `compare`, `cellEffort`, etc.) for `studio-web`. (**Internal**, except persisted schema types).
- `reeval/testing`: `fakeInstructions`, `declareTree`. (**Internal**).

---

## 2. Configuration Schema (`reeval.config.ts`) & Option Cascade

Config discovery searches upwards for `reeval.config.{ts,mts,cts,js,mjs,cjs}` or `reeval.yaml` / `reeval.yml`. `defineConfig` accepts an object or synchronous callback `({ secret, skill, mcp, plugin, file, directory, git, ci, command, hostEnv, profile }) => ReevalConfig`.

**Cascade order:** `reeval.config.ts` → `profiles.<name>.defaults` (and `profile.judge`) → outer `group()` → inner `group()` → `evaluate()` → `profiles.<name>.limit` (narrows `runs`, `compare`, `harness` unless listed in `pin`) → CLI flags (`--runs`, `--tag`, `--concurrency`).

| Option Key | `reeval.config.ts` | Profile `defaults` | `group` / `evaluate` | Profile `limit` | Notes / Defaults |
|---|:---:|:---:|:---:|:---:|---|
| `include` | ✓ | | | | Glob list; default `['evals/**/*.eval.ts', 'evals/**/*.eval.py']` |
| `harness` | ✓ | ✓ | ✓ | ✓ (`string[]` ids) | Default `cursor({ model: 'composer-2.5' })`. Group/eval also take `{ add }`, `{ only }`, or `(inherited) => …` |
| `sandbox` | ✓ | ✓ | ✓ | | Default machine (`docker()`) when environment omits `sandbox` |
| `environment` | ✓ | ✓ | ✓ | | From `defineEnvironment()`. Forbidden alongside `compare.baseline` |
| `compare` | | | ✓ | ✓ (`false \| { maxVariants }`) | `{ baseline?, variants, gate?: 'variants'\|'all'\|'none', minLift?, harness?, questions?, across? }` |
| `runs` | ✓ | ✓ | ✓ | ✓ (`number`) | Attempts per cell (default `1`). CLI `--runs <n>` overrides all |
| `gate` | ✓ | ✓ | ✓ | | `'all'` (default, pass^k) or `{ passRate: number }` (pass@1 in `(0, 1]`) |
| `env` | ✓ | ✓ | ✓ | | `Record<string, string \| Secret>`, merged by key down cascade |
| `egress` | ✓ | ✓ | ✓ | | `'allow-all'` (default) \| `'deny-all'` \| `{ allow: string[] }`. Group/eval overrides environment, which overrides config/profile |
| `judge` | ✓ | ✓ (+ `profile.judge`) | ✓ | | `{ model?, threshold?: 0.8, providerOptions?, maxConcurrent?, state? }` (`state`: `task`, `output`, `files`, `diff`, `contents`, `transcript`, `turns`, `checks`) |
| `capture` | ✓ | ✓ | ✓ | | `{ viewport?: { width, height } \| 'full-page', timeout?: '60s', browser?: boolean, model?: string }` |
| `question` | ✓ | ✓ | ✓ | | `{ model?, state?, artifacts?: true \| string[] }` (`state` like `judge.state` minus `contents`) |
| `timeout` | ✓ | ✓ | ✓ | | `Duration` (`number` ms or `'ms'\|'s'\|'m'\|'h'`); default `'15m'` |
| `tags` | | (`profile.tags`) | ✓ | | `string[]`; unioned down groups/eval. Profile/CLI `--tag` supports `!tag` |
| `pin` | | | ✓ | | `Array<'harness' \| 'runs' \| 'compare'>` — protects from `profile.limit` |
| `concurrency` | ✓ | | | | Max parallel attempts (default `min(8, cpus, floor(memGB))`) |
| `record` | ✓ | (`profile.record`) | | | `'manual' \| 'ci' \| 'always'` (default `'ci'`) |
| `history` | ✓ | | | | `{ dir?: '<evalRoot>/.history', artifacts?: 'all' \| 'failures' \| 'none' }` |
| `budget` | ✓ | (`profile.budget`) | | | `{ attempts?: number, duration?: Duration }` |
| `profiles` | ✓ | | | | `Record<string, { defaults?, limit?, judge?, budget?, record?, tags? }>` |
| `defaultProfile` | ✓ | | | | `{ ci?: string, local?: string }` |
| `secrets` | ✓ | | | | `{ unbrokered?: 'warn' \| 'error' }` (default `'warn'`) |
| `debug` | ✓ | | | | `{ keep?: 20, traceBufferMb?: 8 }` |
| `analysis` | ✓ | | | | `{ model?, insights?: true, maxTokens?: 250000, instructions?, maxInputTokens?: 20000, maxOutputTokens?: 8000 }` |

---

## 3. Environment & Target Helpers (`defineEnvironment` & `.extend` / `.extendEnvironment`)

| Helper / Field | Signature & Options | Status |
|---|---|---|
| `workspace` / `git` | `git(repo, { ref?, path?, init?, token? })` — URL, `github:owner/repo`, GitHub `/tree/<ref>/<path>`, or local path. `token` names a host env var. | Public |
| `files` / `file` / `directory` | `files: Record<string, string \| HostFile>` (workspace-relative or `~/`). `file(path)`. `directory(path, { into?, glob?, defaultIgnores?: true })`. | Public |
| `rules` | `string \| HostFile` — written to harness's rules file (`AGENTS.md`, or `CLAUDE.md` for Claude Code). | Public |
| `setup` | `Array<string \| { run: string, timeout?: Duration, cwd?: string }>` (default timeout `'5m'`, runs before agent with secrets). | Public |
| `env` / `secret` | `secret(opts?)`, `secret.fromEnv(name, opts?)` where `opts = { optional?: boolean, to?: 'agent' \| 'checks', hosts?: string[], in?: Array<'header'\|'query'\|'body'> }`. `secret.template('Bearer ${TOKEN}')`. `secret.hosts.{gemini,openai,anthropic,github}`. | Public |
| `skills` / `skill` | `skill.local(path, { only?, exclude?, placement? })`, `skill.git(repo, { ref?, path?, only?, exclude?, placement? })`, `skill.registry('owner/repo@skill', { version?, placement? })`, `skill.npm(spec, { path?: 'skills', only?, exclude?, placement? })`, `skill.inline({ name, description, content, files? }, { placement? })`. `placement`: `'harness'` (default) \| `'workspace'`. | Public |
| `mcp` | `mcp.stdio(command, args?, { env? })`, `mcp.http(url, { headers? })`, `mcp.sse(url, { headers? })`. HTTPS header secrets auto-brokered to server's host. | Public |
| `plugins` / `plugin` | `plugin.local(path, opts?)`, `plugin.git(repo, { ref?, path?, ...opts })`, `plugin.npm(spec, { path?, ...opts })`, `plugin.marketplace('name@source', { ref?, ...opts })` where `opts = { only?: PluginPart[], build?: string \| string[] \| { run, cwd? } }` (`PluginPart`: `'skills'\|'agents'\|'commands'\|'hooks'\|'mcp'\|'rules'`). | Gate 1 |
| `env.extend` | `env.extend(name, spec)` / `env.extendEnvironment(name, spec)` — layers `env`, `files`, `mcp`, `skills`, `plugins` (by name), appends `setup`, replaces `sandbox`, `workspace`, `egress`, `rules` when set. | Public |

---

## 4. `expect()` Matchers & Assertions

Supports `expect(actual, label?)`, `.not`, `expect.soft(actual, label?)`, `expect.poll(fn, { interval?: 50, timeout?: 1000, message? })`, plus standard Chai/Vitest matchers (`toBe`, `toEqual`, `toBeNull`, `toBeTruthy`, `toContain`, etc.). Unawaited async assertions fail the attempt.

| Matcher | Subject | Signature & Semantics |
|---|---|---|
| `toHaveFile` | `Turn \| AttemptContext` | `await expect(turn \| c).toHaveFile(path, pattern?: string \| RegExp)` (async) |
| `toSucceed` | `ExecResult \| Promise<ExecResult>` | `await expect(c.exec(cmd)).toSucceed()` — checks `exitCode === 0` (async) |
| `toPass` | `Verdict \| JudgeFailure` | `expect(await c.judge(question, opts?)).toPass()` — checks `verdict === 'pass'` (`score >= threshold`) |
| `toHaveChanged` | `Turn \| AttemptContext` | `expect(turn \| c).toHaveChanged(paths?: string \| RegExp \| ReadonlyArray<string \| RegExp>)` — checks workspace git diff |
| `toHaveEdited` | `Turn \| AttemptContext` | `expect(turn \| c).toHaveEdited(path?: string \| RegExp)` — checks `file-edit` events and tool calls mentioning `path` |
| `toHaveRun` | `Turn \| AttemptContext` | `expect(turn \| c).toHaveRun(command?: string \| RegExp)` — checks `bash` / `shell` tool calls |
| `toHaveCalledTool` | `Turn \| AttemptContext` | `expect(turn \| c).toHaveCalledTool(name: string \| RegExp, input?: string \| RegExp \| Record<string, unknown>)` |
| `toHaveCalledMcp` | `Turn \| AttemptContext` | `expect(turn \| c).toHaveCalledMcp(server: string, tool: string, input?: ToolInputMatch)` — matches `mcp__<server>__<tool>` |
| `toHaveCalledSkill` | `Turn \| AttemptContext` | `expect(turn \| c).toHaveCalledSkill(name: string)` — checks `skill` / `Skill` / `load_skill` or file reads under `skills/<name>/` |
| `toHaveSearched` | `Turn \| AttemptContext` | `expect(turn \| c).toHaveSearched(query?: string \| RegExp)` — checks `web-search` events (throws `HarnessCapabilityError` if `unreported`) |
| `toHaveFetched` | `Turn \| AttemptContext` | `expect(turn \| c).toHaveFetched(url?: string \| RegExp)` — checks `web-fetch` events (throws `HarnessCapabilityError` if `unreported`) |

---

## 5. CLI Commands, Flags, Terminal Output & Exit Codes

Global flags on all commands: `--config <path>`, `-h, --help`, `--version`. Binary names: `reeval` (alias `re`).

| Command | Positional Args & Flags | Purpose |
|---|---|---|
| `reeval init [dir]` | `--harness <name>`, `-y, --yes`, `--bare`, `--force`, `--dry-run` | Scaffold config, environment, eval, `.gitignore`, `package.json`, `tsconfig.json` |
| `reeval doctor` | `--online`, `--json` | Check Node, config, Docker/Podman & memory, sandbox images, keys, judge, analysis, egress, `.gitignore`, `.env` files |
| `reeval run [filter...]` | `--profile <name>`, `--dry-run`, `--json`, `--force`, `--runs <n>`, `--concurrency <n>`, `--tag <tag>`, `--record`, `--ui <live\|plain\|agent>`, `--log-order <stream\|grouped>`, `--log-prefix <task\|none>`, `--output-logs <full\|errors-only\|none>`, `-v, --verbose`, `-vv, --trace`, `--resume [ref]`, `--no-insights` | Plan and run evals |
| `reeval image build [filter...]` | `--profile <name>`, `--dry-run`, `--force` | Build/refresh harness base, `from`, `dockerfile`, `install`, and plugin build layers |
| `reeval clean` | `--keep <n>`, `--images` | Prune `.reeval/debug` runs and unused reeval Docker/Podman images |
| `reeval record [run...]` | `--artifacts <all\|failures\|none>`, `--allow-incomplete`, `--skip-secret-scan` | Copy scratch runs from `.reeval/runs` to `.history` |
| `reeval history [filter]` | `--limit <n>`, `--all`, `--json` | Pass/fail strip per eval over recent runs |
| `reeval show [run]` | `--json`, `--md` | Print one run's result blocks, `summary.md`, or `RunRecord` JSON |
| `reeval compare [base] [head]` | `--md`, `--json`, `--fail-on-regression`, `-v, --verbose` | Diff two runs (`regressed`, `fixed`, `can't compare`, `infra error`, `new`, `removed`, `+N same`) |
| `reeval checkout [run] [dir]` | *(none)* | Detached git worktree at the run's commit + `worktree.patch` |
| `reeval query [sql \| view]` | `--run <id\|last>`, `--json`, `--schema`, `--rebuild` | Read-only SQLite query over `.reeval/history.db` |
| `reeval analyze [run]` | `--vs <run\|none>`, `--eval <filter>`, `--save`, `--context`, `--dry-run`, `--json`, `--md`, `--no-cache`, `--insights`, `-v, --verbose` | LLM analysis of a run digest, or `--insights` to generate `insights.json` |
| `reeval mcp` | `--http`, `--port <n>` (4986), `--host <addr>`, `--token <value>` | Read-only MCP server over run history (stdio or Streamable HTTP at `/mcp`) |
| `reeval studio` | `--port <n>` (4984), `--host <addr>`, `--open`, `--no-scratch`, `--no-token` | Local web studio with live run progress & debug tab |
| `reeval studio build` | `--out <dir>` (`studio-dist`), `--scratch`, `--no-artifacts` | Static studio site export |
| `reeval report [run]` | `--out <dir\|file>`, `--json`, `--last`, `--issue`, `-y, --yes` | Redacted bug report bundle (`.reeval/reports/`) |

**Exit Codes (`src/cli.ts`):** `0` (`ok`), `1` (`failed`), `2` (`usage`), `3` (`infra`), `130` (`interrupted`, SIGINT), `143` (`terminated`, SIGTERM).

**Terminal Output Layouts (`src/ui/layout.ts`, `src/view/suite.ts`):**
- **Verdict words:** `pass`, `fail`, `infra error`, `cancelled`, `skipped`, `todo`, `not gated` (when all cells have `gate: 'none'`).
- **Layout shapes (`layout()`):** `results` (single/sandbox cells), `choose` (tool-choice evals classified by insights), `measure` (compare arms), `harnesses` (multi-harness), `both` (harnesses × arms), `regressions` (`reeval compare`), plus `family: true` for pooled `evaluate.each` (`all cases` row).
- **Variant effect words (`EFFECT`):** `helped` (`better`), `made it worse` (`worse`), `can't tell yet` (`unclear`, including `< 4` counted tries per side), empty for `same`; with `minLift` failure appends `not by minLift <N>`. `-v` prints `difference ±N points, 95% interval ±L…±H`.
- **Check & Effort tables:** Failing/not-run checks shown with `+N more passed`; effort table (`tools`, `time`, `tokens`) shown when `>= 4` tries and effort differs or eval failed; compare questions print `won W of N`.
- **Insights & Remarks:** Model-generated eval answers, row sentences, findings, and run headline (citing `SuiteResult` paths); followed by tally (`N fail · M pass…`), optional `Set analysis.model in reeval.config.ts for answers to what each eval asks.`, and `Remarks:` (capped at 3 concerns unless `-v`; model kinds: `name-contradicts`, `name-no-intent`, `judge-too-loose`, `judge-leaks-answer`, `prompt-names-tool`, `compound-judge`; deterministic kinds: `flaky-check`, `no-baseline`, `slow-mcp-start`, `too-few-tries`, `check-never-fails`).

---

## 6. SQL Views, Tables, MCP Server Tools & Environment Variables

### `reeval query` Views (16) & Tables (17)

- **Views (`VIEW_NAMES`):** `lift`, `family_lift`, `effort`, `contrasts`, `question_pairs`, `factor_effects`, `skill_reads`, `context_use`, `skill_files`, `flaky_cells`, `drift`, `failing_attempts`, `eval_trend`, `verdict_flips`, `check_discrimination`, `check_rates`, `check_streaks`.
- **Tables (`DATA_TABLES`):** `runs`, `evals`, `families`, `votes`, `question_pairs_m`, `cells`, `attempts`, `judgements`, `environments`, `env_skills`, `artifacts`, `attempt_context`, `tool_calls`, `context_reads`, `mcp_startup`, `assertions`, `cell_checks`.

### `reeval mcp` Tools & Resources (`src/mcp/server.ts`)

- **Core tools (8):** `failures`, `history`, `show`, `compare`, `analysis`, `transcript`, `query`, `query_schema`.
- **View tools (17):** `query_<view>` for each view in `VIEW_NAMES` above (`where` exact column filter + `limit`).
- **Resources (2):** `reeval://runs/{runId}` (JSON record), `reeval://runs/{runId}/transcripts/{attempt}` (JSONL transcript).

### Environment Variables

- **`REEVAL_*` (enforced by `scripts/docs.mjs` on `reference/env-vars`):**
  - Run & config: `REEVAL_PROFILE`, `REEVAL_CONCURRENCY`, `REEVAL_CAPTURE_BROWSER` (`0` refuses host browser), `REEVAL_MCP_TOKEN`
  - UI & output: `REEVAL_UI` (`live\|plain\|agent\|auto`), `REEVAL_LOG_ORDER` (`stream\|grouped\|auto`), `REEVAL_LOG_PREFIX` (`task\|none\|auto`), `REEVAL_OUTPUT_LOGS` (`full\|errors-only\|none\|auto`), `REEVAL_HEARTBEAT` (duration or `0`)
  - Debugging & diagnostics: `REEVAL_DEBUG`, `REEVAL_RAW_TRANSCRIPT`, `REEVAL_NO_REPORT_HINT`
  - Dockerfile arg: `REEVAL_BASE`
  - Internal / runner / fake variables also scanned by `scripts/docs.mjs`: `REEVAL_BACKGROUND`, `REEVAL_FAKE_EXEC`, `REEVAL_PROJECT_ROOT`, `REEVAL_PYTHON`, `REEVAL_PYTHON_SDK`, `REEVAL_RUNNER`, `REEVAL_RUNNER_TOKEN`
- **Standard & Provider Credentials:**
  - Harnesses: `CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY`, `XAI_API_KEY` (plus `OPENCODE_PROVIDERS` keys & `AWS_REGION`)
  - Judges & Analysis: `TYPESAFE_AI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`
  - Host / CI: `CI`, `GITHUB_ACTIONS`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, `NO_COLOR`, `FORCE_COLOR`, `XDG_CACHE_HOME`
