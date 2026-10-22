# reeval Surface Area Inventory (Gate 1)

Source-verified inventory of `packages/reeval` (`0.12.0`), `packages/reeval-python`, and `scripts/docs.mjs` on `origin/main` (`fb4bc326`).

## 0. Gate 1 Decision Checklist for Ben

Please confirm **Public** vs. **Experimental** vs. **Exclude from Docs** for these surfaces before Gate 2:

- [ ] **1. Plugins (`plugins` / `plugin.{local,git,npm,marketplace}`, `PluginBuild`):** Enforced by `scripts/docs.mjs` in the harness matrix (`[//]: # (generated:harness-matrix)`). Document as a first-class public feature or mark experimental?
- [ ] **2. Harnesses (`fx`, `grokBuild`, `goose`, `pi`, `opencode`):** `scripts/harness-matrix.mjs` requires `docs/reference/harness/<kind>.mdx` for all 9 harnesses (`cursor`, `claude-code`, `antigravity`, `opencode`, `goose`, `pi`, `codex`, `fx`, `grok-build`). Keep all 9 public, or mark `fx` / others experimental?
- [ ] **3. Podman (`podman()` in `reeval/sandbox`):** Exported alongside `docker()` with identical `DockerOptions`. Document alongside `docker()` as public?
- [ ] **4. Browser Capture & Vision Journeys (`c.serve`, `c.capture`, `capture` option, `artifacts` on `c.judge` / `question`):** Enforced in `option-keys`. Document as public or experimental?
- [ ] **5. Pairwise Compare Questions (`compare.questions`, `compare.across`, `question` option, `question_pairs` view):** Public or experimental?
- [ ] **6. Run Insights & Eval Quality Remarks (`analysis.model`, `analysis.insights`, `analysis.maxTokens`, `reeval analyze --insights`, `Remarks:`):** Default in `reeval init`. Public core workflow?
- [ ] **7. `reeval override`:** Not present in `cli-spec.ts` or anywhere in `src/` (only environment `overrides` array in records). Confirm omitted.
- [ ] **8. `reeval report`:** Redacted diagnostic bundle + `--issue`. Public CLI reference or troubleshooting-only?
- [ ] **9. Multi-language / YAML config (`reeval.yaml`, `*.eval.py` / `reeval-python`, `reeval/testing`):** Keep `reeval/testing` and `reeval-python` internal/excluded, or document Python/YAML?
- [ ] **10. `reeval/view` & Record AST types:** `scripts/docs.mjs` requires `[//]: # (generated:record-types)` (30 types) and `record-values` (6 aliases). Keep `reeval/view` runtime helpers internal while documenting the persisted record schema?

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
