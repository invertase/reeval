// Every user-facing feature of reeval, and what covers it on each tier. The feature matrix
// (COVERAGE.md, `pnpm features:matrix`) is generated from this, the fixture table in
// features.test.ts and the plan cases in plan.test.ts; matrix.test.ts fails when a feature has
// nothing on any tier and isn't a known gap, when a fixture or plan case covers no feature, or
// when an entry names something that doesn't exist.

export type InventoryFeature = {
  /** Stable, dotted, e.g. `skill.git`. */
  id: string
  area: Area
  /** The feature as the docs name it. */
  name: string
  /** Directories under test/features/. Their tiers (fake, docker, podman, real) come from features.test.ts. */
  fixtures?: string[]
  /** Plan cases in plan.test.ts, as `dir/name`. */
  plan?: string[]
  /**
   * Plain `node:test` cases (the unit tier, including runner-level tests through the CLI), as
   * `<path under packages/> › <the test's title, or a part of it>`.
   */
  tests?: string[]
  /**
   * Checks in the real-agent suites: `contract › <behaviour>` (a behaviour in contract.test.ts,
   * on every real harness), `e2e › <the test's title, or a part of it>` (e2e-real.test.ts) or
   * `questions › <title>` (questions-real.test.ts, a real model answering compare questions).
   */
  real?: string[]
  /** Why nothing covers it yet. Only for features with no fixture, plan case or test. */
  gap?: string
}

export const AREAS = [
  'Config and selection',
  'Environments',
  'Sandbox',
  'Harnesses',
  'Judges and matchers',
  'Records and studio',
  'CLI and runner',
] as const
export type Area = (typeof AREAS)[number]

const unit = (name: string) => `reeval/test/unit.test.ts › ${name}`
const declaration = (name: string) => `reeval/test/declaration.test.ts › ${name}`
const options = (name: string) => `reeval/test/options.test.ts › ${name}`
const engine = (name: string) => `reeval/test/engine.test.ts › ${name}`
const secrets = (name: string) => `reeval/test/secrets.test.ts › ${name}`
const harness = (name: string) => `reeval/test/harness.test.ts › ${name}`
const docker = (name: string) => `reeval/test/docker.test.ts › ${name}`
const prepareContract = (name: string) => `reeval/test/sandbox-prepare-contract.test.ts › ${name}`
const debug = (name: string) => `reeval/test/debug.test.ts › ${name}`
const studio = (name: string) => `reeval/test/studio.test.ts › ${name}`
const analysis = (name: string) => `reeval/test/analysis.test.ts › ${name}`
const query = (name: string) => `reeval/test/query.test.ts › ${name}`
const workspace = (name: string) => `reeval/test/workspace.test.ts › ${name}`
const checks = (name: string) => `reeval/test/checks.test.ts › ${name}`
const engineExpect = (name: string) => `reeval/test/engine-expect.test.ts › ${name}`
const judgeState = (name: string) => `reeval/test/judge-state.test.ts › ${name}`
const history = (name: string) => `reeval/test/history.test.ts › ${name}`
const plugin = (name: string) => `reeval/test/plugins.test.ts › ${name}`
const planTest = (name: string) => `reeval/test/plan.test.ts › ${name}`
const sandboxDocker = (file: string, name: string) =>
  `sandbox-docker/test/${file}.test.ts › ${name}`
const cursorAdapter = (file: string, name: string) =>
  `harness-cursor-sdk/test/${file}.test.ts › ${name}`
const opencodeAdapter = (file: string, name: string) =>
  `harness-opencode/test/${file}.test.ts › ${name}`
const gooseAdapter = (file: string, name: string) => `harness-goose/test/${file}.test.ts › ${name}`
const grokAdapter = (file: string, name: string) =>
  `harness-grok-build/test/${file}.test.ts › ${name}`
const piAdapter = (file: string, name: string) => `harness-pi/test/${file}.test.ts › ${name}`
const codexAdapter = (file: string, name: string) => `harness-codex/test/${file}.test.ts › ${name}`
const fxAdapter = (file: string, name: string) => `harness-fx/test/${file}.test.ts › ${name}`

export const inventory: InventoryFeature[] = [
  // Config and selection
  {
    id: 'config.define',
    area: 'Config and selection',
    name: '`defineConfig` (object or function) and its defaults',
    plan: ['matrix/default'],
    tests: [unit('resolveConfig defaults')],
  },
  {
    id: 'config.mistakes',
    area: 'Config and selection',
    name: 'Config and option mistakes exit 2 with the fix',
    tests: [
      options('common mistakes'),
      engine('usage errors exit 2'),
      'reeval/test/cli.test.ts › run and image build without a config file exit 2',
      unit('requireConfig refuses a missing file with the config names doctor lists'),
    ],
  },
  {
    id: 'config.dotenv',
    area: 'Config and selection',
    name: "`.env` and `.env.local` loading, from the config's directory",
    tests: [engine('.env.local wins over .env, the shell wins over both, and evals see them')],
  },
  {
    id: 'config.discovery',
    area: 'Config and selection',
    name: 'Finding the nearest `reeval.config.*` upward from the current directory; `--config` wins',
    fixtures: ['config/found-from-subdirectory'],
    tests: [
      unit('findConfig takes the nearest config at or above the directory'),
      'reeval/test/history.test.ts › every command run from a nested subdirectory finds the project config',
      "reeval/test/history.test.ts › a nested project's own config wins over the parent's",
    ],
  },
  {
    id: 'matrix.harness-runs',
    area: 'Config and selection',
    name: '`harness` lists × `runs`, and `--runs`',
    plan: ['matrix/default', 'matrix/runs-override'],
    tests: [
      unit('expand: per harness, the control then each variant'),
      options('harness lists and runs expand into attempts'),
    ],
  },
  {
    id: 'matrix.cascade',
    area: 'Config and selection',
    name: 'Option cascade through groups and evals; harness edits (`{ add }`, `{ only }`, functions)',
    plan: ['harness-edits/data-and-functions'],
    tests: [
      engine('groups nest, cascade options'),
      options('groups replace the harness list, evals can edit it'),
      options('harness edits as data: { add } appends to the inherited list, { only } keeps by id'),
    ],
  },
  {
    id: 'compare',
    area: 'Config and selection',
    name: '`compare`: control, variants, lift and `minLift`',
    plan: ['compare/control-and-variants', 'compare/independent'],
    fixtures: ['compare/independent'],
    tests: [
      options('variants run next to the control, lift is stored'),
      'reeval/test/results.test.ts › Newcombe',
    ],
  },
  {
    id: 'evaluate.each',
    area: 'Config and selection',
    name: '`evaluate.each`: one eval per case, pooled into a family with a pass rate and a paired lift that `minLift` gates; `{ pool: false }`',
    plan: ['compare/each-pooled', 'compare/each-filtered', 'selection/tags'],
    fixtures: ['run/each-case'],
    tests: [
      options('evaluate.each pools its cases into one paired lift that minLift gates'),
      options('a pooled lift below minLift fails the run'),
      options('evaluate.each with { pool: false } records independent evals'),
      options('a pooled family over several runs a case pairs per-case pass rates'),
      options('common mistakes'),
      'reeval/test/results.test.ts › Newcombe method 10',
      "reeval/test/results.test.ts › McNemar's exact p",
      'reeval/test/results.test.ts › the signed-rank p',
      'reeval/test/results.test.ts › the t interval over per-case differences',
    ],
  },
  {
    id: 'compare.harness',
    area: 'Config and selection',
    name: '`compare.harness`',
    plan: ['compare/harness-scoped'],
    tests: [options('compare.harness scopes variants')],
  },
  {
    id: 'compare.baseline',
    area: 'Config and selection',
    name: '`compare.baseline` omitted: the cascaded environment, or an empty `baseline`, is the control',
    plan: [
      'compare/baseline-omitted',
      'compare/baseline-omitted-off',
      'environments/empty-control',
    ],
    fixtures: ['compare/baseline-omitted', 'compare/baseline-empty'],
    tests: [options('common mistakes')],
  },
  {
    id: 'compare.questions',
    area: 'Config and selection',
    name: '`compare.questions`: questions in the plan, answered after the run with pairwise win rates',
    plan: [
      'compare/questions',
      'compare/questions-dropped',
      'compare/questions-group',
      'compare/questions-across',
    ],
    tests: [
      options('--dry-run names the questions with no language model'),
      options('an evaluation model as the judge or the analysis model exits 2'),
      options("a question's own model needs its key"),
      options('with a language model the run plans its questions'),
      options('votes are recorded after the attempts'),
      options('a question with across: environment records only environment pairs'),
      options('compare.across sets the default factor'),
      options('a question across overrides compare.across'),
      options('a vote reason is recorded, shown and left out of pass or fail'),
      options('a model error is kept on its answer'),
      'reeval/test/results.test.ts › a vote reason is stored, capped and sampled',
      options('common mistakes'),
      'reeval/test/results.test.ts › compare question pairs',
      'reeval/test/results.test.ts › compare questions over real-harness runs (real-e2e-pairs)',
      studio("compare answers: each question's win rates per cut"),
    ],
    real: ['questions › examples/hello --profile questions'],
  },
  {
    id: 'compare.questions.state',
    area: 'Config and selection',
    name: "Compare questions' `state` and `artifacts`, and the `question` option: the model that answers and what each side shows, cascaded",
    plan: ['compare/questions-state', 'compare/questions-model'],
    fixtures: [
      'compare/question-default',
      'compare/question-state',
      'compare/question-cascade',
      'compare/question-artifacts',
    ],
    tests: [
      'reeval/test/results.test.ts › state chooses what each side shows; output and files stay out by default',
      'reeval/test/results.test.ts › canary: state off drops a part the default shows',
      "reeval/test/results.test.ts › artifacts send each side's own capture of that name, labelled by position",
      options("question.model cascades to every question without its own; an entry's model wins"),
      options('common mistakes'),
    ],
  },
  {
    id: 'compare.questions.input',
    area: 'Records and studio',
    name: "`evals[].answers[].input`: what each compare question's model was sent, per pair and order",
    fixtures: ['compare/question-input'],
    tests: [studio("compare answers: each question's win rates per cut")],
  },
  {
    id: 'gate',
    area: 'Config and selection',
    name: "`gate` (`'all'`, `{ passRate }`) and `compare.gate`",
    tests: [
      'reeval/test/results.test.ts › the option takes all or { passRate }',
      "reeval/test/results.test.ts › 'all' matches { passRate: 1 }",
      options('a config-level gate applies to every eval'),
    ],
  },
  {
    id: 'gate.hint',
    area: 'Config and selection',
    name: "The default-gate hint: printed for an eval whose gated cells run more than once at the default gate, not for a study whose cells are all `gate: 'none'`",
    plan: ['compare/study', 'compare/control-and-variants'],
    tests: [
      options(
        "'all' by default, { passRate } per eval or group, with a hint when runs > 1 and no gate",
      ),
    ],
  },
  {
    id: 'profiles',
    area: 'Config and selection',
    name: 'Profiles: `defaults`, `limit`, `pin`, selection and typos',
    plan: [
      'profiles/local-none',
      'profiles/pr-in-ci',
      'profiles/nightly',
      'oracle/oracle',
      'oracle/canary',
    ],
    tests: [
      unit('selectProfile: --profile, then REEVAL_PROFILE'),
      unit('cascade: profile defaults sit under evals'),
      options('a profile name typo exits 2'),
    ],
  },
  {
    id: 'config.yaml',
    area: 'Config and selection',
    name: '`reeval.yaml`: the config as data, with profiles, `--config` and one config per directory',
    plan: ['yaml/default', 'yaml/pr-in-ci', 'yaml/nightly', 'yaml/config-flag'],
    tests: [
      unit('findConfig takes a reeval.yaml, and refuses it beside another config'),
      options('a reeval.yaml mistake, or a reeval.yaml beside reeval.config.ts, exits 2'),
    ],
  },
  {
    id: 'config.paths',
    area: 'Config and selection',
    name: "One path rule for reeval.yaml, TypeScript and declaration trees: a relative host path (files, rules, skills, a local repository, a Dockerfile, a fake sandbox's `dir`), from a helper or its data form, resolves against the directory of the file it's written in",
    plan: [
      'yaml-paths/from-above',
      'yaml-paths/profile-from-above',
      'ts-paths/from-above',
      'ts-paths/profile-from-above',
      'tree-paths/tree-from-above',
      'tree-paths/helpers-from-above',
    ],
    tests: [
      unit("a reeval.yaml's relative host paths resolve against its directory"),
      unit(
        'a relative host path resolves the same in reeval.yaml, TypeScript data and the helpers',
      ),
      unit('fakeSandbox resolves a relative dir against the file that calls it'),
      declaration("a tree's relative host paths resolve against the declaring file's directory"),
      declaration('a tree with relative paths plans the same tests as with absolute ones'),
      declaration("a tree's missing Dockerfile is refused at its absolute path, naming the field"),
    ],
  },
  {
    id: 'profiles.max-variants',
    area: 'Config and selection',
    name: '`limit.compare.maxVariants`',
    plan: ['compare/max-variants'],
  },
  {
    id: 'profiles.compare-off',
    area: 'Config and selection',
    name: '`limit.compare: false`, or `maxVariants` leaving none: the lone control gates like an eval without compare',
    plan: ['compare/off-study', 'compare/zero-variants', 'compare/baseline-omitted-off'],
  },
  {
    id: 'plan.json',
    area: 'Config and selection',
    name: '`reeval run --dry-run` and `--dry-run --json`',
    plan: ['matrix/default'],
    tests: [
      'reeval/test/plan.test.ts › is one document with the host-dependent fields',
      'reeval/test/plan.test.ts › --json without --dry-run runs, and prints the suite result instead of the plan',
    ],
  },
  {
    id: 'budget',
    area: 'Config and selection',
    name: '`budget.attempts`, `budget.duration` and `--force`',
    plan: ['profiles/pr-in-ci'],
    tests: [
      options('a plan over budget.attempts exits 2 unless --force'),
      options('budget.duration stops new attempts'),
    ],
  },
  {
    id: 'budget.recorded',
    area: 'Records and studio',
    name: 'Budget-stopped runs are recorded with status `budget`',
    tests: [
      options('budget.duration stops new attempts'),
      options('a budget-stopped run is auto-recorded in CI and by record: always'),
    ],
  },
  {
    id: 'selection.modes',
    area: 'Config and selection',
    name: '`evaluate.only`, `.skip`, `.todo` and `.for`; `group.only`',
    plan: ['selection/only-local'],
    tests: [
      options('.only runs alone locally and exits 2 in CI'),
      options('tags filter, todo, for'),
      options('common mistakes'),
      engine('skip is reported as skipped'),
      'reeval/test/plan.test.ts › .only in CI exits 2 before any plan prints',
    ],
  },
  {
    id: 'selection.group-skip',
    area: 'Config and selection',
    name: '`group.skip` and `group.todo`, and todo shown in the plan, summary, record and studio',
    plan: ['selection/only-local'],
    tests: [
      engine("a skipped group's evals, nested ones too, are recorded as skipped and never run"),
      engine('group.todo shows as todo, like evaluate.todo'),
    ],
  },
  {
    id: 'selection.tags',
    area: 'Config and selection',
    name: 'Tags: `--tag`, `!tag` and profile tags',
    plan: ['selection/tags'],
    tests: [options('tags filter, todo, for')],
  },
  {
    id: 'selection.filters',
    area: 'Config and selection',
    name: 'Filters (path, eval name, cell key; the kinds narrow each other); no match exits 2',
    plan: ['compare/mixed-filter', 'selection/group-and-eval-filter'],
    tests: [
      engine('filters match paths, then eval names'),
      engine('a path filter and a cell filter together run only that cell of that file'),
      options('a filter that matches nothing exits 2'),
      "reeval/test/plan.test.ts › a cell filter narrows each row's counts in the text plan",
      'reeval/test/plan.test.ts › a filter part that matches no file, eval name or cell exits 2',
    ],
  },

  // Environments
  {
    id: 'skill.harness',
    area: 'Environments',
    name: '`skill.local`, placed by the harness',
    fixtures: [
      'skills/harness-placement',
      'harness/claude-code-harness-skills',
      'harness/antigravity-home-skills',
      'harness/opencode-home-skills',
      'harness/goose-home-skills',
      'harness/pi-home-skills',
      'harness/grok-build-home-skills',
      'harness/codex-home-skills',
      'harness/fx-home-skills',
    ],
    real: ['contract › skill placed where the agent reads it, and used'],
  },
  {
    id: 'skill.workspace',
    area: 'Environments',
    name: "`skill.local` with `placement: 'workspace'`",
    fixtures: [
      'skills/workspace-placement',
      'skills/workspace-content',
      'harness/cursor-workspace-skills',
      'harness/claude-code-workspace-skills',
      'harness/antigravity-workspace-skills',
      'harness/opencode-workspace-skills',
      'harness/goose-workspace-skills',
      'harness/grok-build-workspace-skills',
      'harness/pi-workspace-skills',
      'harness/codex-workspace-skills',
      'harness/fx-workspace-skills',
    ],
  },
  {
    id: 'skill.git',
    area: 'Environments',
    name: '`skill.git`: ref, `path` (else `skills/` when the root has no SKILL.md), `only` and the recorded commit',
    fixtures: ['skills/git-ref', 'skills/git-skills-dir'],
    tests: [unit('git refs and repo shorthands'), options('skills come from a git URL at a ref')],
  },
  {
    id: 'environment.workspace',
    area: 'Environments',
    name: '`workspace: git(…)`: a repository or directory at a ref, fetched on the host, with its commit and tree recorded',
    fixtures: [
      'workspace/git-subpath',
      'workspace/files-over-repo',
      'workspace/setup-in-repo',
      'workspace/missing-ref',
    ],
    plan: ['workspace/git'],
    tests: [
      workspace('a ref the repository lacks fails only the attempts that use it'),
      workspace('a missing subdirectory names what is there'),
      workspace('a pinned SHA reruns offline from the cache, with the same commit and tree'),
      workspace("the agent's diff starts from the repository, and a variant's workspace overrides"),
      options('common mistakes'),
    ],
  },
  {
    id: 'environment.workspace.init',
    area: 'Environments',
    name: '`git(…, { init: true })`: a `.git` with one commit of the fetched tree',
    fixtures: ['workspace/init'],
    tests: [
      workspace(
        'init: true gives the workspace a .git that the diff leaves out, and the same HEAD in every attempt',
      ),
    ],
  },
  {
    id: 'environment.workspace.token',
    area: 'Environments',
    name: '`git(…, { token })`: a token from a host variable for the fetch, never in the sandbox or the record',
    fixtures: ['workspace/token', 'workspace/token-sandbox-env'],
    tests: [
      workspace(
        'a token fetches over HTTPS on the host, a wrong one is an auth failure, and neither is written anywhere',
      ),
      workspace('a token variable that is not set fails only its attempts, naming the variable'),
    ],
  },
  {
    id: 'skill.inline',
    area: 'Environments',
    name: '`skill.inline`',
    tests: [options('skills come from a git URL at a ref')],
  },
  {
    id: 'skill.registry',
    area: 'Environments',
    name: '`skill.registry`',
    fixtures: ['skills/registry-version'],
  },
  {
    id: 'skill.npm',
    area: 'Environments',
    name: '`skill.npm`',
    fixtures: ['skills/npm-package', 'skills/npm-local-path'],
  },
  {
    id: 'environment.plugins',
    area: 'Environments',
    name: '`plugins`: `plugin.local`, `plugin.git` and `plugin.npm` in Claude Code’s layout, `only`, layering, the refusals per harness and the record',
    fixtures: [
      'plugins/local-lands',
      'plugins/only-skills',
      'plugins/git-ref',
      'plugins/npm-package',
    ],
    plan: ['plugins/parts', 'plugins/remote', 'plugins/fetches-at-start'],
    tests: [
      plugin('a plugin is read in Claude Code’s layout'),
      plugin('every real harness refuses every plugin'),
      plugin('a child’s plugin replaces a same-named parent plugin'),
      planTest('every real harness refuses a plugin at plan time'),
      planTest('a plugin the plan reads and refuses exits 2'),
    ],
  },
  {
    id: 'plugin.marketplace',
    area: 'Environments',
    name: '`plugin.marketplace`: an entry in a Claude Code marketplace on git or npm, its own source resolved, and the marketplace in the record',
    fixtures: ['plugins/marketplace-entry'],
    plan: ['plugins/marketplace'],
    tests: [
      plugin('a marketplace entry’s source is a ./path, a git repository or an npm package'),
      plugin('a marketplace reeval can’t read'),
      plugin('resolving a marketplace entry places that plugin alone'),
    ],
  },
  {
    id: 'skill.exclude',
    area: 'Environments',
    name: 'Skill `exclude`: the defaults and a custom list',
    fixtures: ['skills/exclude-default', 'skills/exclude-custom'],
    tests: [
      unit('excludeMatcher is gitignore-style'),
      unit('skill directories leave out eval material'),
    ],
  },
  {
    id: 'skill.only-missing',
    area: 'Environments',
    name: '`only` naming a missing skill',
    fixtures: ['skills/only-missing'],
  },
  {
    id: 'skill.frontmatter',
    area: 'Environments',
    name: '`SKILL.md` frontmatter as YAML',
    tests: [unit('SKILL.md frontmatter is parsed as YAML')],
  },
  {
    id: 'mcp.stdio',
    area: 'Environments',
    name: '`mcp.stdio`',
    fixtures: ['mcp/stdio-reaches-harness'],
    tests: [
      options('skills, MCP, rules, files, setup steps and secrets reach the sandbox'),
      harness('gets MCP servers in the .mcp.json shape'),
      secrets('MCP stdio env secrets are brokered only with explicit hosts'),
    ],
    real: ['contract › stdio MCP server started and called'],
  },
  {
    id: 'mcp.http',
    area: 'Environments',
    name: '`mcp.http`',
    tests: [secrets('MCP header secrets are brokered to the server')],
  },
  {
    id: 'mcp.sse',
    area: 'Environments',
    name: '`mcp.sse`',
    plan: ['egress/cascade'],
    tests: [
      'reeval/test/harness.test.ts › resolves to an SSE server and reaches every harness in its SSE shape',
      'reeval/test/plan.test.ts › an mcp.sse server on OpenCode, Goose, pi or Codex exits 2 at plan time',
    ],
  },
  {
    id: 'secret.template',
    area: 'Environments',
    name: '`secret.template` in MCP headers',
    tests: [
      secrets('MCP header secrets are brokered to the server'),
      secrets('MCP header secrets on plain HTTP stay real values'),
    ],
  },
  {
    id: 'rules',
    area: 'Environments',
    name: '`rules`: `AGENTS.md` for Cursor, Antigravity, OpenCode, Goose, pi, Codex, fx and Grok Build, `CLAUDE.md` for Claude Code',
    fixtures: [
      'env/rules',
      'harness/cursor-rules',
      'harness/claude-code-rules',
      'harness/antigravity-rules',
      'harness/opencode-rules',
      'harness/grok-build-rules',
      'harness/goose-rules',
      'harness/pi-rules',
      'harness/codex-rules',
      'harness/fx-rules',
      'harness/cursor-rules-reach-agent',
    ],
    tests: [harness('rules win over a file at the same path')],
    real: ['contract › rules read'],
  },
  {
    id: 'files.workspace',
    area: 'Environments',
    name: '`files` in the workspace, and `file()`; paths that leave it are refused',
    tests: [
      options('skills, MCP, rules, files, setup steps and secrets reach the sandbox'),
      options('common mistakes'),
    ],
  },
  {
    id: 'files.home',
    area: 'Environments',
    name: '`files` under `~/`',
    fixtures: ['env/files-home'],
    tests: [options('common mistakes')],
  },
  {
    id: 'files.binary',
    area: 'Environments',
    name: '`files` from `file()` are copied as bytes',
    fixtures: ['env/files-binary'],
  },
  {
    id: 'files.directory',
    area: 'Environments',
    name: '`directory()`: a host directory as `files`, with `into`, ordered `glob` patterns, `DEFAULT_DIRECTORY_IGNORES` and the executable bit',
    fixtures: ['env/files-directory', 'env/files-directory-executable'],
    plan: ['files/directory'],
    tests: [
      unit(
        'directory() globs are ordered gitignore-style patterns: includes, excludes and re-includes',
      ),
      unit('directory() walks a host directory into files entries'),
      unit("a host file's executable bit is kept and feeds the digest"),
      options('common mistakes'),
    ],
  },
  {
    id: 'env.vars',
    area: 'Environments',
    name: '`env` variables, `secret.fromEnv` and `optional`',
    fixtures: ['secrets/checks-visible-to-checks'],
    tests: [options('a missing secret is an infra error')],
  },
  {
    id: 'secret.checks',
    area: 'Environments',
    name: "`to: 'checks'` secrets: hidden from the agent",
    fixtures: ['secrets/checks-hidden-from-agent'],
    tests: [secrets('twin: during a check, the checks secret is active')],
  },
  {
    id: 'secret.brokered',
    area: 'Environments',
    name: 'Brokered secrets (`hosts`, `in`) and their placeholders',
    fixtures: [
      'secrets/brokered-agent-sees-placeholder',
      'secrets/brokered-checks-see-placeholder',
    ],
    plan: ['secrets/brokered'],
    tests: [
      secrets('the sandbox gets a placeholder, and the gateway the value on its hosts'),
      sandboxDocker('docker', 'a brokered secret: the upstream gets the value'),
    ],
  },
  {
    id: 'secret.unbrokered',
    area: 'Environments',
    name: '`secrets: { unbrokered }` and the unbrokered warning',
    tests: [
      options('a Docker secret without hosts warns once in the plan'),
      options("an optional secret that isn't set gets no real-value warning"),
      options(
        "secrets: { unbrokered: 'error' } refuses an optional secret whether or not it's set",
      ),
      secrets('lists env and MCP secrets the sandbox would get as real values'),
    ],
  },
  {
    id: 'redaction',
    area: 'Environments',
    name: 'Secrets masked in everything reeval writes',
    fixtures: ['secrets/redaction-coverage'],
    tests: [
      unit('redactSecrets masks secret-looking env values'),
      secrets('redacting encoded forms'),
      secrets('redacting fragments of a secret'),
      secrets("every variable of a header's secret.template is a secret the run masks"),
      debug(
        "a declared secret under a plain name is masked in an eval's logs and failures on screen",
      ),
      debug("a secret in an error that stops the run is masked, config's and an eval file's"),
    ],
  },
  {
    id: 'setup.steps',
    area: 'Environments',
    name: '`setup` steps: order, a failing step named, a missing `cwd`, `setup.log`',
    fixtures: ['env/setup-order', 'env/setup-missing-cwd'],
    tests: [options('a failing setup step names itself')],
  },
  {
    id: 'setup.timeout',
    area: 'Environments',
    name: "A setup step's own `timeout`",
    fixtures: ['env/setup-timeout'],
  },
  {
    id: 'env.extend',
    area: 'Environments',
    name: '`extendEnvironment`, overrides and the environment digest',
    fixtures: ['env/setup-order', 'env/sandbox-extend-replace'],
    tests: [
      unit('extendEnvironment layers and overrides; a separate environment does not'),
      harness('one environment has one digest'),
    ],
  },
  {
    id: 'environment.sandbox',
    area: 'Environments',
    name: '`sandbox` on `defineEnvironment`; cell identity includes the image; `.extend` replaces or keeps it; a named env that omits sandbox uses the root machine',
    fixtures: ['env/sandbox-image', 'env/sandbox-extend-replace', 'env/sandbox-inherit'],
    plan: [
      'environments/images',
      'environments/extend-replace',
      'environments/config-control',
      'environments/inherit-config',
      'environments/empty-control',
    ],
    tests: [
      options('common mistakes'),
      unit('extendEnvironment layers and overrides; a separate environment does not'),
      unit('named compare uses the cascaded sandbox option, not the config environment'),
    ],
  },
  {
    id: 'c.first-use',
    area: 'Environments',
    name: 'The sandbox starts on first use: checks without a turn, one start for concurrent first calls',
    fixtures: [
      'sandbox/read-before-send',
      'sandbox/concurrent-first-use',
      'env/files-home',
      'skills/workspace-placement',
    ],
  },
  {
    id: 'env.write-file',
    area: 'Environments',
    name: "`c.writeFile()`: files placed after a turn, outside later turns' diff until changed",
    fixtures: ['sandbox/write-file', 'sandbox/write-file-edit'],
    tests: [unit('c.writeFile refuses absolute paths and paths that leave the workspace')],
  },

  // Sandbox
  {
    id: 'docker.run',
    area: 'Sandbox',
    name: 'Docker: run, diff, and removal, on timeout too',
    tests: [
      docker('runs checks in the container, diffs, and removes it'),
      docker('a timeout removes the container'),
      docker("npm installs the packed reeval tarball in reeval's image"),
    ],
  },
  {
    id: 'sandbox.contract',
    area: 'Sandbox',
    name: 'Sandbox `exec`, `readFile`, `writeFile` and `~/`, fake and Docker',
    tests: [
      'reeval/test/sandbox-contract.test.ts › writeFile then exec reads it',
      unit('the fake sandbox reads and writes ~/ paths'),
    ],
  },
  {
    id: 'docker.install',
    area: 'Sandbox',
    name: '`docker({ install })` layers',
    plan: ['images/install-from-dockerfile'],
    tests: [
      docker('a failing install command names itself'),
      docker('concurrent attempts in two workers share one build'),
      sandboxDocker('unit', 'install layers are keyed on the base image id'),
    ],
  },
  {
    id: 'docker.dockerfile',
    area: 'Sandbox',
    name: '`docker({ dockerfile })` and `REEVAL_BASE`',
    fixtures: [
      'harness/claude-code-dockerfile',
      'harness/antigravity-dockerfile',
      'harness/opencode-dockerfile',
      'harness/goose-dockerfile',
      'harness/pi-dockerfile',
      'harness/codex-dockerfile',
      'harness/fx-dockerfile',
      'harness/grok-build-dockerfile',
    ],
    plan: ['images/install-from-dockerfile'],
    tests: [
      docker('dockerfile: FROM the REEVAL_BASE arg'),
      sandboxDocker('unit', 'the Dockerfile tag hashes the Dockerfile'),
      sandboxDocker('build-failure', 'a rebuilt reeval image (a new id) is a new tag'),
    ],
  },
  {
    id: 'docker.confinement',
    area: 'Sandbox',
    name: 'Docker confinement: the `reeval` user, no capabilities, `no-new-privileges`, and `docker({ root, capabilities })`',
    fixtures: ['sandbox/unprivileged', 'sandbox/no-unshare'],
    tests: [
      sandboxDocker(
        'confinement',
        'every command, spawn and file write runs as the unprivileged sandbox user',
      ),
      sandboxDocker(
        'confinement',
        'no capabilities, and no-new-privileges; root: true adds back only what apt-get needs',
      ),
      sandboxDocker('confinement', 'install layers put ~ in the sandbox user’s home, owned by it'),
      sandboxDocker(
        'confinement',
        'network configuration, iptables and new namespaces are refused',
      ),
      sandboxDocker(
        'confinement',
        'changing or dropping the proxy variables finds no other way out',
      ),
      sandboxDocker(
        'confinement',
        'the forwarder, its port and the gateway CA are out of the sandbox user’s reach',
      ),
      sandboxDocker('confinement', 'a root: true sandbox is still detached from every network'),
    ],
  },
  {
    id: 'podman.sandbox',
    area: 'Sandbox',
    name: "`podman({ … })`: `docker()`'s sandbox on rootless Podman, on the bridge network with Docker's seccomp profile",
    fixtures: ['sandbox/podman-bridge', 'sandbox/no-unshare'],
    plan: ['environments/podman'],
    tests: [
      sandboxDocker(
        'unit',
        "podman runs every container on the bridge with Docker's seccomp profile",
      ),
      sandboxDocker('build-failure', 'reading a failed podman build (buildah)'),
      'reeval/test/doctor.test.ts › podman: down, too old, missing cgroup controllers',
    ],
  },
  {
    id: 'docker.privilege-warnings',
    area: 'Sandbox',
    name: 'Warnings for `docker({ root: true })` and `docker({ capabilities })`, per level that sets them',
    plan: ['privileges/levels', 'privileges/profile'],
    tests: [
      'reeval/test/plan.test.ts › are structured in the JSON plan, one per level that set the sandbox',
      'reeval/test/plan.test.ts › print in the text plan, the agent output and as GitHub annotations',
      'reeval/test/plan.test.ts › canary: an eval without root gets no warning, so the check fails',
      docker('a root sandbox warns at the start of reeval run, in the record and in summary.md'),
    ],
  },
  {
    id: 'docker.login-shell-path',
    area: 'Sandbox',
    name: "Login shells keep the image's `PATH` (`/etc/profile.d/00-reeval-path.sh`)",
    fixtures: ['sandbox/login-shell-path', 'sandbox/login-shell-path-dockerfile'],
  },
  {
    id: 'docker.limits',
    area: 'Sandbox',
    name: '`docker({ memory, cpus, pids })` and their defaults',
    fixtures: ['sandbox/limits'],
    tests: [
      sandboxDocker('confinement', 'default limits: memory with as much swap on top, CPUs and'),
      sandboxDocker('confinement', 'each limit is overridable, and CPUs are capped'),
      sandboxDocker('confinement', 'a fork bomb stops at the process limit'),
      sandboxDocker('confinement', 'memory past the limit is killed'),
    ],
  },
  {
    id: 'docker.swap',
    area: 'Sandbox',
    name: '`docker({ swap })`: swap on top of memory, as much as memory by default',
    fixtures: ['sandbox/swap'],
    tests: [
      sandboxDocker('confinement', 'swap: 0 makes memory the hard ceiling'),
      sandboxDocker('unit', '--memory-swap is memory plus swap'),
    ],
  },
  {
    id: 'docker.oom-is-infra',
    area: 'Sandbox',
    name: 'An OOM kill during an attempt is an infra error',
    fixtures: ['sandbox/oom-is-infra'],
    tests: [
      sandboxDocker(
        'confinement',
        'oomKills counts the processes the kernel killed at the memory limit',
      ),
    ],
  },
  {
    id: 'docker.from',
    area: 'Sandbox',
    name: '`docker({ from })` toolchain images',
    tests: [
      options('reeval image build --dry-run lists every image'),
      docker('from: a toolchain image gets Node, git and the harness baked on'),
    ],
  },
  {
    id: 'sandbox.prepare',
    area: 'Sandbox',
    name: 'Preflight: every sandbox prepared before any attempt; a failure fails only its cells, or stops the run from the config',
    tests: [
      docker('an eval-level image that fails fails only its cells, each once, built once'),
      docker('a config-level image that fails stops the run before any attempt'),
      docker('two sandboxes on one failing from build it once'),
    ],
  },
  {
    id: 'sandbox.prepare-contract',
    area: 'Sandbox',
    name: 'The sandbox provider prepare contract: check, key, prepare, classify (a scripted provider and Docker)',
    tests: [
      prepareContract('bad credentials fail the check'),
      prepareContract('a transient failure is retried, bounded, and stays transient'),
      prepareContract('canary: a deterministic failure is tried once'),
      prepareContract('out of memory and out of disk are resource failures, named'),
      prepareContract('a config-level sandbox that fails stops the run'),
      prepareContract('a flaky step is retried until it passes'),
    ],
  },
  {
    id: 'image.from-digest',
    area: 'Sandbox',
    name: '`from` digests: recorded, kept by `reeval run`, flagged by `--dry-run` and rebuilt by `reeval image build` when the tag moves',
    tests: [docker('a from tag that moves upstream')],
  },
  {
    id: 'run.dry-run-images',
    area: 'CLI and runner',
    name: '`reeval run --dry-run` checks each sandbox image: ready, to build, stale or missing',
    tests: [docker('reeval image build builds every image, reports every failure and exits 3')],
  },
  {
    id: 'image.failures',
    area: 'Sandbox',
    name: 'Image build failures: the headline first, ENOSPC and exit 137 named, transient errors retried',
    tests: [
      docker('a failing install command names itself and is an infra error, headline first'),
      docker('ENOSPC and exit 137 in install are named in the headline'),
      docker('a Dockerfile syntax error, and a from that is not Debian, say so first'),
      docker('a registry that cannot be reached is retried, bounded'),
      sandboxDocker('build-failure', 'the failing step'),
      sandboxDocker('build-failure', 'network and registry 5xx errors are transient'),
      sandboxDocker('build-failure', 'a transient failure is retried, then succeeds'),
    ],
  },
  {
    id: 'image.clean',
    area: 'Sandbox',
    name: '`reeval clean --images`, and no `-base` tag or replaced image left behind',
    tests: [
      docker('reeval clean --images removes the images reeval left dangling'),
      docker('from: a toolchain image gets Node, git and the harness baked on'),
    ],
  },
  {
    id: 'image.build',
    area: 'Sandbox',
    name: '`reeval image build` (every image, every failure, exit 3, `--force`) and its `--dry-run`',
    tests: [
      options('reeval image build --dry-run lists every image'),
      docker('reeval image build builds every image, reports every failure and exits 3'),
    ],
  },
  {
    id: 'egress',
    area: 'Sandbox',
    name: '`egress`: allowlist or deny-all, enforced in Docker and recorded per attempt',
    fixtures: [
      'egress/allowed-host-reachable',
      'egress/blocked-host-recorded',
      'egress/deny-all',
      'egress/secret-hosts-allowed',
      'egress/harness-under-deny-all',
      'egress/expected-blocked',
    ],
    plan: ['egress/cascade', 'egress/profile-defaults'],
    tests: [
      sandboxDocker('docker', 'allowlist: a listed host gets 200'),
      sandboxDocker('docker', 'no direct route: custom and deny-all'),
      sandboxDocker('unit', 'deny list: every always-denied form'),
    ],
    real: ['contract › deny-all plus auto hosts works, a blocked host refused and recorded'],
  },
  {
    id: 'brokering.harness-key',
    area: 'Sandbox',
    name: "The harness's key never enters the container",
    fixtures: ['secrets/cursor-session-tokens'],
    tests: [
      sandboxDocker('docker', 'env, /proc and files in the container never contain the real key'),
      harness('credential brokering per agent'),
      docker('Goose gets the key on the model list it fetches each turn, and nothing is refused'),
    ],
    real: ['contract › real key never in the container'],
  },
  {
    id: 'harness.auth-hint',
    area: 'Harnesses',
    name: 'A refused harness key names its variable and how to fix it',
    tests: [
      unit('an auth failure names the credential; other errors get no hint'),
      docker('Cursor attempts broker the key; without brokering the attempt fails closed'),
      docker('Claude Code attempts broker the key on its endpoints'),
      'reeval/test/docker-antigravity.test.ts › Antigravity attempts broker the key on its model endpoint only',
      docker('Goose gets the key on the model list it fetches each turn'),
      docker('Gemini refusing the key fails the turn and names the host variable'),
      docker('grokBuild: the key is brokered on the xAI API only'),
    ],
  },
  {
    id: 'ports',
    area: 'Sandbox',
    name: 'Ports: through the tunnel, or published without the gateway',
    tests: [
      sandboxDocker('docker', 'port tunnel: same URL and live connection'),
      sandboxDocker('docker', 'without the gateway the bridge port is published'),
    ],
  },
  {
    id: 'cleanup',
    area: 'Sandbox',
    name: 'No container or sandbox left after a failure, timeout or abort',
    tests: [
      sandboxDocker('session', 'an abort at any point while creating leaves no container'),
      'reeval/test/concurrency.test.ts › timeouts under concurrency fail every attempt and destroy every sandbox',
    ],
    real: ['contract › clean teardown', 'e2e › no container outlives the runs'],
  },

  // Harnesses
  {
    id: 'harness.cursor-real',
    area: 'Harnesses',
    name: 'Real Cursor, end to end',
    fixtures: [
      'skills/harness-placement',
      'mcp/stdio-reaches-harness',
      'harness/cursor-rules-reach-agent',
      'harness/cursor-reports-usage',
      'secrets/cursor-session-tokens',
    ],
  },
  {
    id: 'harness.claude-code',
    area: 'Harnesses',
    name: '`claudeCode()`: its image, rules, skills and MCP shape',
    fixtures: [
      'harness/claude-code-rules',
      'harness/claude-code-workspace-skills',
      'harness/claude-code-dockerfile',
    ],
    plan: ['harnesses/claude-code'],
    tests: [harness('reads rules from CLAUDE.md and repo skills from .claude/skills')],
  },
  {
    id: 'harness.antigravity',
    area: 'Harnesses',
    name: '`antigravity()`: its image, rules, skills, MCP shape and brokered Gemini key',
    fixtures: [
      'harness/antigravity-rules',
      'harness/antigravity-workspace-skills',
      'harness/antigravity-home-skills',
      'harness/antigravity-dockerfile',
    ],
    plan: ['antigravity/antigravity'],
    tests: [
      harness('reads rules from AGENTS.md, repo skills from .agents/skills'),
      harness("the key is swapped in on Antigravity's model endpoint only"),
    ],
  },
  {
    id: 'harness.opencode',
    area: 'Harnesses',
    name: "`opencode()`: OpenCode 2 over ACP on a brokered provider's key, its image, config, rules, skills, tool names, web search and config MCP servers",
    fixtures: [
      'harness/opencode-rules',
      'harness/opencode-workspace-skills',
      'harness/opencode-home-skills',
      'harness/opencode-dockerfile',
    ],
    plan: ['opencode/opencode'],
    tests: [
      harness('OpenCode reads rules from AGENTS.md, repo skills from .opencode/skills'),
      harness("the key is swapped in on OpenCode's model endpoint only"),
      harness("OpenCode's edits and writes are file edits, relative to the workspace"),
      opencodeAdapter('stream', 'names a call from its first update, and keeps the usage'),
      opencodeAdapter('stream', "a tool's output is its content's text, with its metadata"),
      opencodeAdapter('stream', "a web search's results are its references"),
      opencodeAdapter(
        'unit',
        'MCP servers go in the config with codemode off, and the gate waits for them',
      ),
      opencodeAdapter(
        'gate',
        'the first prompt waits for the MCP servers to connect, and what follows keeps its order',
      ),
      opencodeAdapter(
        'unit',
        'the config turns off updates, sharing and the tools an eval has no use for',
      ),
      opencodeAdapter('unit', "session titles run on the turn's model, not a second one"),
      opencodeAdapter('unit', 'the musl builds are left out of the install, and only those'),
    ],
  },
  {
    id: 'harness.opencode.providers',
    area: 'Harnesses',
    name: "`opencode({ model: '<provider>/<model>' })`: OpenCode on any provider whose key goes in a header on known hosts, with only that provider's key brokered, its hosts automatic and its served model recorded; the others refused at plan time",
    fixtures: ['harness/opencode-provider-key'],
    plan: ['opencode/opencode', 'opencode/bedrock-region'],
    tests: [
      "reeval/test/plan.test.ts › OpenCode on a provider reeval can't broker exits 2 at plan time",
      harness('is plain data with its own cell id, and needs a model on a provider it can broker'),
      harness("the config refuses a hand-made descriptor on a provider it can't broker"),
      harness("needs only the model's provider's key"),
      harness("each provider's hosts are its automatic egress hosts, with Exa's for web search"),
      harness("elsewhere the gateway reads the served model from each model call's response"),
      harness("OpenCode's adapter brokers only the model's provider's key, to its API"),
      harness(
        "on Bedrock, it needs AWS_BEARER_TOKEN_BEDROCK, and AWS_REGION's hosts are its egress hosts",
      ),
      opencodeAdapter('providers', "Bedrock's hosts are its AWS_REGION's, us-east-1 by default"),
      opencodeAdapter('providers', 'Bedrock brokers its API key as a Bearer token'),
      opencodeAdapter('providers', "the main providers' keys go where OpenCode sends them"),
      opencodeAdapter('providers', 'a model that can’t run says why'),
      opencodeAdapter(
        'providers',
        'the served model comes from the URL where it names one, else the response',
      ),
      opencodeAdapter(
        'unit',
        "the model's provider calls over HTTP, where the gateway reads the served model",
      ),
      "reeval/test/replay.test.ts › GPT's patch tool is an edit, and the files it changed are file edits",
    ],
  },
  {
    id: 'harness.goose',
    area: 'Harnesses',
    name: '`goose()`: Goose over ACP on a brokered Gemini key, its image, rules, skills, MCP extensions and tool names',
    fixtures: [
      'harness/goose-rules',
      'harness/goose-workspace-skills',
      'harness/goose-home-skills',
      'harness/goose-dockerfile',
    ],
    plan: ['goose/goose'],
    tests: [
      harness(
        'Goose reads rules from AGENTS.md, repo skills from .goose/skills, home skills in its own home',
      ),
      harness("Goose's adapter brokers only the Gemini key, as GOOGLE_API_KEY, to the Gemini API"),
      gooseAdapter('stream', 'names a call from its tool_call metadata, and drops the usage'),
      gooseAdapter('unit', "MCP servers are enabled extensions in Goose's config.yaml"),
    ],
  },
  {
    id: 'harness.pi',
    area: 'Harnesses',
    name: '`pi()`: pi in the sandbox (`pi --mode json`) on a brokered Gemini key, with per-call tokens and stdio and HTTP MCP servers',
    fixtures: [
      'harness/pi-rules',
      'harness/pi-workspace-skills',
      'harness/pi-home-skills',
      'harness/pi-dockerfile',
    ],
    plan: ['pi/pi'],
    tests: [
      harness(
        'pi reads rules from AGENTS.md, repo skills from .pi/skills and home skills from ~/.pi/agent/skills',
      ),
      harness(
        "MCP servers go in pi's mcp.json shape; it has no SSE transport and refuses odd names",
      ),
      'reeval/test/plan.test.ts › pi and Goose take stdio and http MCP servers; pi exits 2 on a server name it would skip',
      piAdapter(
        'unit',
        'a session with MCP servers writes mcp.json under the home and loads the mcp extension',
      ),
      piAdapter('unit', 'env and header values are escaped so pi reads them literally'),
      harness("pi's adapter brokers only the Gemini key, as GEMINI_API_KEY, to the Gemini API"),
      piAdapter(
        'stream',
        'a real multi-call turn: tool calls, results, one step per model call and their summed tokens',
      ),
    ],
  },
  {
    id: 'harness.codex',
    area: 'Harnesses',
    name: '`codex()`: Codex in the sandbox (`codex exec --json`) on a brokered OpenAI key, with per-turn tokens, and the served model and effort from the gateway',
    fixtures: [
      'harness/codex-rules',
      'harness/codex-workspace-skills',
      'harness/codex-home-skills',
      'harness/codex-dockerfile',
    ],
    plan: ['codex/codex'],
    tests: [
      harness(
        'Codex reads rules from AGENTS.md and skills from .agents/skills and ~/.agents/skills',
      ),
      harness(
        "Codex's key is brokered to the Responses API only, whose response names the served model",
      ),
      harness("MCP servers go in Codex's config.toml shape; it has no SSE transport"),
      harness(
        "Codex's file changes are file edits: an added file is created, an updated one modified",
      ),
      codexAdapter(
        'stream',
        "a refused key: each retry a failed step, then the turn's error and an error finish",
      ),
      codexAdapter(
        'unit',
        "the config turns off analytics and plugins, and uses reeval's HTTP provider on the key",
      ),
      sandboxDocker(
        'proxy',
        'asks for it uncompressed and records the model and effort, the body passed through whole',
      ),
    ],
  },
  {
    id: 'harness.fx',
    area: 'Harnesses',
    name: '`fx()`: fx over ACP on a brokered AI Gateway or OpenAI key, through a relay to the egress gateway, with per-turn tokens and its tool names',
    fixtures: [
      'harness/fx-rules',
      'harness/fx-workspace-skills',
      'harness/fx-home-skills',
      'harness/fx-dockerfile',
    ],
    plan: ['fx/fx'],
    tests: [
      harness(
        'reads rules from AGENTS.md, repo skills from .fx/skills, home skills in its own home',
      ),
      harness("fx's adapter brokers only its provider's key, as a Bearer token, to that provider"),
      harness("gets MCP servers in ACP's shape, a bare stdio command through env's PATH lookup"),
      fxAdapter('unit', 'a gateway id runs on AI Gateway, a bare id on OpenAI'),
      fxAdapter(
        'unit',
        "MCP calls are renamed from fx's mcp_<server>_<tool>, longest server first",
      ),
      fxAdapter(
        'unit',
        "a command's result is its streamed output and exit code, not fx's clipped summary",
      ),
    ],
  },
  {
    id: 'harness.cursor',
    area: 'Harnesses',
    name: '`cursor()`: Cursor through its TypeScript SDK, one runner per session',
    fixtures: ['harness/cursor-rules', 'harness/cursor-workspace-skills'],
    plan: ['cursor/cursor'],
    tests: [
      harness('is plain data with its own cell id, and needs a model'),
      harness("gets MCP servers in the SDK's McpServerConfig shape"),
      cursorAdapter('harness', 'one runner serves every turn'),
      cursorAdapter('harness', 'after the runner exits, the next turn starts one'),
    ],
  },
  {
    id: 'harness.effort',
    area: 'Harnesses',
    name: '`effort` on each harness factory: default id, requested vs served',
    fixtures: ['harness/effort-requested-and-served'],
    plan: ['effort/effort'],
    tests: [
      harness('effort is the value that CLI takes, folded into the default id'),
      cursorAdapter('harness', 'effort maps onto the catalog param, not Fast'),
      piAdapter('unit', 'effort is --thinking'),
      codexAdapter('unit', 'effort is model_reasoning_effort in the config'),
      gooseAdapter('unit', 'effort is GOOSE_THINKING_EFFORT'),
      grokAdapter('unit', "effort is the config's default_reasoning_effort"),
      opencodeAdapter('unit', "effort is that provider's thinking option"),
    ],
  },
  {
    id: 'harness.usage',
    area: 'Harnesses',
    name: 'Token usage and the served model, per turn and totalled, from any harness',
    fixtures: ['harness/cursor-reports-usage'],
    tests: [
      harness('token usage and the served model, from any harness'),
      harness('OpenCode: ACP PromptResponse.usage as harness-acp maps it'),
    ],
    real: [
      'contract › tokens recorded where the harness reports them',
      'contract › served model recorded',
    ],
  },
  {
    id: 'harness.web-events',
    area: 'Harnesses',
    name: "Web search and fetch events (Cursor's recovered from its stored conversation), `turn.unreported`, `toHaveSearched` and `toHaveFetched`",
    fixtures: ['harness/cursor-web-fetch', 'harness/opencode-web-search'],
    tests: [
      harness('web calls the runner recovers survive the adapter, HarnessAgent and the normaliser'),
      harness('the SDK stream loses them before our first layer'),
      harness("a Cursor turn is unreported for the web tools the runner couldn't recover"),
      cursorAdapter('stream', 'a real web turn on SDK 1.0.32'),
      cursorAdapter('stream', "the runner's recovered web calls"),
      cursorAdapter('unit', 'storedWebCalls: a live stored conversation'),
      cursorAdapter(
        'unit',
        'the live conversation from SDK 1.0.32 has every field the runner reads',
      ),
      cursorAdapter('unit', 'each field it reads, gone or renamed, is named in the problem'),
      "reeval/test/cursor-sdk-shape.test.ts › the image's @cursor/sdk declares every field the runner reads",
      'reeval/test/replay.test.ts › upstream fixed, same ids: each web call once',
      'reeval/test/replay.test.ts › upstream fixed, other ids: each web call once',
      'reeval/test/matchers.test.ts › refuse a turn whose harness',
      harness('a tool-error search is web-search with ok: false'),
      harness('a pending search (no result) is web-search with ok: false'),
      harness("Antigravity's isError webSearch becomes a web-search event"),
      'reeval/test/matchers.test.ts › pass on a refused web-search',
    ],
    real: ['contract › nothing silently unreported'],
  },
  {
    id: 'harness.fake-script',
    area: 'Harnesses',
    name: '`fakeHarness({ script })` and `layout`',
    fixtures: ['secrets/checks-hidden-from-agent', 'harness/cursor-rules'],
    tests: [
      harness('a fake agent with a layout is placed exactly like that agent'),
      engine("a turn's error message shows in the summary, agent output and summary.md without -v"),
    ],
  },
  {
    id: 'harness.turn-aborted',
    area: 'Harnesses',
    name: 'A turn the timeout cuts off is recorded as `aborted`',
    fixtures: ['harness/turn-aborted-on-timeout'],
    tests: [
      'harness-cursor-sdk/test/stream.test.ts › an aborted turn with content closes its step before it finishes',
    ],
  },
  {
    id: 'harness.transcripts',
    area: 'Harnesses',
    name: 'Transcripts, normalised per harness',
    tests: [
      "reeval/test/replay.test.ts › reeval's normaliser still finds its signals",
      harness('a real turn normalises: relative edits, mcp__ names, timed tools'),
      harness('its Edit and Write tools are file edits'),
      docker('Claude Code attempts broker the key on its endpoints'),
    ],
    real: ['contract › file edited and command run, both in the transcript'],
  },

  {
    id: 'harness.stream-format',
    area: 'Harnesses',
    name: "Each agent CLI's native stream: replayed through the adapters, and checked for format drift",
    tests: [
      'reeval/test/replay.test.ts › the same tool calls, text and tokens as when it was captured',
      'reeval/test/replay.test.ts › a new event kind, step type, key or tool is a format change',
    ],
    real: ['contract › native stream format unchanged'],
  },
  {
    id: 'record.served-model',
    area: 'Harnesses',
    name: "The models a harness's API requests named on the wire (`servedModels`)",
    tests: ['reeval/test/harness.test.ts › its brokered requests name the served model'],
    real: ['contract › served model recorded'],
  },
  {
    id: 'record.resolved-variant',
    area: 'Harnesses',
    name: "The model variant a harness resolved (`composer-2.5[fast=true]`), in the stack's `resolvedModels`, `-v`, `summary.md` and the studio",
    tests: [engine('the resolved model variant is in the record, the stack, -v and summary.md')],
    real: ['contract › served model recorded'],
  },

  // Judges and matchers
  {
    id: 'judge',
    area: 'Judges and matchers',
    name: 'Judge verdicts, errors, option cascade and retries',
    tests: [
      engine('judge options cascade from config to group, eval and call'),
      engine('a failing judge fails the eval as a judge error'),
      engine(
        'c.judge with an empty question or a threshold outside 0…1 fails without asking the judge',
      ),
      unit('judge calls retry transient provider errors'),
    ],
  },
  {
    id: 'judge.scope',
    area: 'Judges and matchers',
    name: 'What the judge is given: `judge.state` (task, output, files, diff patterns, contents by path or pattern, transcript, turns, checks) merged key by key from the config to the call; build output, source maps, build info and minified files dropped from its diff',
    fixtures: [
      'judge/build-output',
      'judge/state-diff',
      'judge/state-contents',
      'judge/state-contents-glob',
      'judge/state-off',
      'judge/state-transcript',
      'judge/state-turns',
      'judge/state-checks',
      'judge/state-cascade',
    ],
    tests: [
      unit('the judge drops build output, source maps, build info and minified files'),
      unit("the judge's state.diff patterns filter its diff and files"),
      engine('judge state cascades key by key from the config to the call'),
      engine(
        "c.judge refuses an unknown option, a command it hasn't run and on without state.output",
      ),
      judgeState('the transcript renders one compact entry per event, by mode'),
      judgeState('state resolves every key to its default, and merges key by key'),
      judgeState('judge options name an unknown key, a misspelt state key and a bad value'),
      history("the config's judge.state is in the record and the fingerprint"),
    ],
  },
  {
    id: 'judge.artifacts',
    area: 'Judges and matchers',
    name: '`c.judge({ artifacts })` sends captures as AI SDK file parts (`true` sends every one); JSON-only calls stay an object',
    fixtures: ['judge/artifacts', 'judge/artifacts-all'],
    tests: [
      unit('decideState keeps JSON-only state an object'),
      unit('TypeSafe Jev takes c.judge artifacts as a multipart image upload'),
      engine('c.judge artifacts must be a capture handle or name on this attempt'),
    ],
  },
  {
    id: 'judge.input-size',
    area: 'Judges and matchers',
    name: "A judge call's provider error, worded as the provider wrote it, with the input's estimated size, biggest parts and files and the `state` keys that were on, largest first; reeval sends what `state` selects, uncut",
    tests: [
      unit("a provider's error keeps its wording and adds what fills the judge's input"),
      judgeState("a provider error keeps the provider's message and names the state keys"),
      engine('the judge gets all of what state selects, however big'),
      engine("a provider's error keeps its wording and names what filled the judge's input"),
    ],
  },
  {
    id: 'judge.soft-failure',
    area: 'Judges and matchers',
    name: 'A failed judge call returns `verdict: "error"`, is recorded, and fails the attempt after its body, so the judges and checks after it still run',
    tests: [
      engine('a judge call that fails is recorded, and the judges and checks after it still run'),
      engine('a judge failure the eval never asserts on still fails the attempt'),
    ],
  },
  {
    id: 'judge.real',
    area: 'Judges and matchers',
    name: 'A real judge model call',
    tests: [engine('a model judge makes a real provider call')],
  },
  {
    id: 'matchers',
    area: 'Judges and matchers',
    name: '`toHaveFile`, `toSucceed` and `toPass`',
    tests: [
      'reeval/test/matchers.test.ts › passes when the file exists',
      'reeval/test/matchers.test.ts › passes on exit 0',
      'reeval/test/matchers.test.ts › passes on a pass verdict',
      engine('an unawaited toHaveFile or toSucceed fails its eval, and runs before teardown'),
      engine('a failure with megabytes of output prints and records a bounded tail'),
    ],
  },
  {
    id: 'assert.named-checks',
    area: 'Judges and matchers',
    name: "Named check results: `expect(value, 'label')`, every `expect` and `expect.soft` recorded per attempt, tallied per cell, and checks that don't discriminate in a compare",
    fixtures: ['assert/labelled', 'compare/check-not-run'],
    tests: [
      engineExpect('each matcher call is recorded in call order'),
      engineExpect('a soft matcher records its own outcome'),
      engineExpect('default labels: the first argument'),
      engineExpect('expect.poll is one entry with its final outcome'),
      checks("a compare tallies each check per side and flags the ones that don't discriminate"),
      checks('without a compare the attempts record their assertions'),
    ],
  },
  {
    id: 'assert',
    area: 'Judges and matchers',
    name: '`expect(c | turn)` transcript matchers: `toHaveCalledSkill`, `toHaveCalledMcp`, `toHaveCalledTool`, `toHaveRun`, `toHaveEdited`, `toHaveSearched`, `toHaveFetched`',
    fixtures: [
      'assert/called-skill',
      'assert/called-skill-path',
      'assert/called-mcp',
      'assert/called-tool-mcp',
      'assert/ran',
      'assert/edited',
    ],
    tests: [
      'reeval/test/assert.test.ts › passes on a dedicated load tool',
      'reeval/test/assert.test.ts › matches type: tool only',
      'reeval/test/assert.test.ts › joins server and tool into mcp__<server>__<tool>',
      "reeval/test/assert.test.ts › toHaveCalledSkill('contract-probe')",
      "reeval/test/assert.test.ts › toHaveCalledMcp('stamp', 'house_stamp')",
      'reeval/test/query.test.ts › skill_reads counts a dedicated skill load',
    ],
  },
  {
    id: 'assert.changed',
    area: 'Judges and matchers',
    name: '`toHaveChanged(paths?)`: files in the workspace diff, matched with globs',
    fixtures: ['assert/changed'],
    tests: [
      'reeval/test/assert.test.ts › matches the diff with globs, directories, RegExps and lists',
      'reeval/test/assert.test.ts › reads c as of its latest turn, and nothing before one',
      'reeval/test/assert.test.ts › names the files it saw',
    ],
  },
  {
    id: 'expect',
    area: 'Judges and matchers',
    name: "Vitest's `expect` from `@vitest/expect`: matchers, diffs, `soft`, `poll`, `assertions`",
    tests: [
      engine('a failing assertion exits 1'),
      engine('expect.soft, expect.poll and expect.assertions work inside an attempt'),
      "reeval/test/engine-expect.test.ts › Vitest's matchers, asymmetric matchers, .not and diffs work unchanged",
      'reeval/test/engine-errors.test.ts › message, diff, the stack with a code frame at the first project frame',
    ],
  },

  // Records and studio
  {
    id: 'history',
    area: 'Records and studio',
    name: 'Recording, merges across branches, rebases and `reeval checkout`',
    tests: [
      'reeval/test/history.test.ts › reeval run writes scratch; reeval record promotes it',
      'reeval/test/history.test.ts › two branches record, merge with zero conflicts',
      'reeval/test/history.test.ts › a dirty run saves worktree.patch',
    ],
  },
  {
    id: 'history.logs',
    area: 'Records and studio',
    name: 'History `.gitignore` un-ignores recorded logs; `reeval record` warns when git still ignores them',
    tests: [
      'reeval/test/history.test.ts › a parent *.log does not drop recorded logs',
      'reeval/test/history.test.ts › reeval record warns when git still ignores a written file',
      'studio-web/test/artifact.test.ts › a recorded path that is not on disk names the usual *.log gitignore',
    ],
  },
  {
    id: 'harness.grok-build',
    area: 'Harnesses',
    name: "`grokBuild()`: xAI's Grok Build over ACP on a brokered xAI key, its image, rules, skills, MCP servers, tool names and the turn's tokens",
    fixtures: [
      'harness/grok-build-rules',
      'harness/grok-build-workspace-skills',
      'harness/grok-build-home-skills',
      'harness/grok-build-dockerfile',
    ],
    plan: ['grok-build/grok-build'],
    tests: [
      harness(
        'Grok reads rules from AGENTS.md, repo skills from .grok/skills, home skills in its own home',
      ),
      harness(
        "Grok Build's adapter brokers only the xAI key, on Authorization, to the xAI API's endpoints",
      ),
      docker('grokBuild: the key is brokered on the xAI API only'),
      grokAdapter(
        'stream',
        "a use_tool call of an MCP server's tool is mcp__<server>__<tool>, with its input",
      ),
      grokAdapter('stream', "the finish part's usage is the turn's sum from the prompt response"),
      grokAdapter(
        'unit',
        "config.toml puts every call on the run's model and turns off the extra calls",
      ),
    ],
  },
  {
    id: 'history.commands',
    area: 'Records and studio',
    name: '`reeval history`, `reeval show` and `reeval compare`, with `--json` and `--md`',
    tests: [
      'reeval/test/history.test.ts › reeval run writes scratch; reeval record promotes it',
      'reeval/test/history.test.ts › an imported helper is part of the fingerprint',
      unit('compare classifies an eval on the cells both runs have, and lists the rest'),
      'reeval/test/history.test.ts › a history file that is not a readable record is named on stderr',
      docker('two runs with the same agent context are comparable'),
    ],
    real: ['e2e › a second identical run', 'e2e › reeval history and reeval show'],
  },
  {
    id: 'compare.fail-on-regression',
    area: 'Records and studio',
    name: '`reeval compare --fail-on-regression`',
    tests: [
      'reeval/test/history.test.ts › reeval compare --fail-on-regression fails on a regression and on a failing new eval',
      'reeval/test/history.test.ts › reeval compare --fail-on-regression fails on a failing eval that changed (not comparable)',
    ],
  },
  {
    id: 'query',
    area: 'Records and studio',
    name: '`reeval query`',
    tests: ['reeval/test/query.test.ts › the projection matches the record'],
    real: ['e2e › reeval query'],
  },
  {
    id: 'mcp',
    area: 'Records and studio',
    name: '`reeval mcp`: run history as read-only MCP tools and resources, over stdio or stateless HTTP',
    tests: [
      'reeval/test/mcp.test.ts › speaks the stateless 2026-07-28 protocol and the 2025 handshake',
      "reeval/test/mcp.test.ts › each query_<view> tool answers what reeval query <view> does, with its columns' filters",
      'reeval/test/mcp.test.ts › query runs one read-only SELECT',
      'reeval/test/mcp.test.ts › show, compare and history answer what their --json does',
      'reeval/test/mcp.test.ts › masks secret-looking values',
      'reeval/test/mcp.test.ts › --http serves stateless Streamable HTTP',
    ],
  },
  {
    id: 'mcp.debugging',
    area: 'Records and studio',
    name: "`reeval mcp` for debugging a failed run: `failures` (each failed attempt's checks, judge scores, error, check logs and transcript tail, and whether its cell failed before) and `history` listing scratch runs, with a note, when nothing is recorded",
    tests: [
      'reeval/test/mcp.test.ts › failures says why each attempt failed, and whether its cell failed before',
      'reeval/test/mcp.test.ts › history falls back to scratch runs with a note',
    ],
  },
  {
    id: 'summary.study-mark',
    area: 'Records and studio',
    name: "An eval whose cells are all `gate: 'none'` is marked ○ and `not gated` in the run summary when its attempts miss, never ✓ beside 0/n",
    tests: [
      engine('an eval with not-gated cells labels its pass@1 gated; an all-gated one does not'),
    ],
  },
  {
    id: 'query.facts',
    area: 'Records and studio',
    name: '`reeval query` facts views: `effort`, `factor_effects` (controlled, pooled, observed, not measured), `skill_reads` and `tool_calls`, `attempt_context`',
    tests: [
      analysis('es-good cuts tool calls 3/3 evals at p = 0.029'),
      analysis('harness contrasts are controlled within a run'),
      analysis('a variant that makes the agent work harder is "more" tool calls'),
    ],
  },
  {
    id: 'query.noise',
    area: 'Records and studio',
    name: '`flaky_cells` pooled over comparable runs with a minimum n, and `drift` with changed paths and a `noise` flag',
    tests: [
      analysis('flaky: one failure in 4 comparable attempts is insufficient'),
      analysis('drift: only Cursor runtime state changed, so it is noise'),
      analysis('a real context file (a skill) that changed is drift, not noise'),
      analysis('mixed outcomes over enough comparable attempts are flaky'),
      analysis('the same change passing and failing its check is caused by the check'),
      'reeval/test/query.test.ts › drift names the changed part',
    ],
  },
  {
    id: 'effort',
    area: 'Records and studio',
    name: 'Effort (tool calls, agent time, and tokens when both sides reported usage): the effort table in `reeval run` and `summary.md` from four counted tries a side, beside lift in `reeval compare` and the studio',
    tests: [
      analysis('the rank test is exact'),
      analysis('tokens join the rank test when both sides reported usage'),
      analysis('a side with no usage omits the token metric, not insufficient'),
      analysis('tokens still verdict among cells that reported usage when another cell did not'),
      analysis('attempts without usage drop out of the token sample only'),
      analysis(
        'reeval run and summary.md print the arms without an effort table below four tries a side',
      ),
      analysis('reeval query effort verdicts tokens when usage is present'),
      analysis('the prompt and rules say missing usage omits tokens'),
      unit('effort under 10s reads in tenths, so a ratio matches its times'),
    ],
  },
  {
    id: 'effort.separation',
    area: 'Records and studio',
    name: 'Effort separation per metric (`no overlap` at 3 vs 3 or more, directional in `reeval analyze`) and the plan hint below 4 runs a cell',
    plan: ['compare/study'],
    tests: [
      analysis('3 against 3 with no overlap on any metric is directional, never an effect'),
      analysis('3 against 3 that overlaps says nothing beyond too few attempts'),
      analysis('2 against 2 is never directional, separated or not'),
      analysis('effort needs 4 runs a cell to be testable'),
    ],
  },
  {
    id: 'contrasts',
    area: 'Records and studio',
    name: 'Contrasts: every arm side by side (checks, effort) in the run output, `reeval show` and `summary.md`; each pair of arms on one harness in `reeval query contrasts` and the digest',
    tests: [
      analysis(
        'show, summary.md and the run set every arm side by side, and reeval query contrasts and the digest every pair',
      ),
      analysis('canary: with one variant there is no variant-against-variant row'),
    ],
  },
  {
    id: 'questions.splits',
    area: 'Records and studio',
    name: 'Compare questions: pairs whose two orders disagree are splits, counted on the answer line, each pair head to head with three sides or more, `reeval query question_pairs` and `votes`, and the digest',
    tests: [
      "reeval/test/results.test.ts › head to head: a pair whose two orders disagree is a split, not a win each (Ben's UX votes)",
      'reeval/test/results.test.ts › canary: two arms get no head-to-head line, and orders that agree split nothing',
      options('three arms: head to head per pair, and pairs the order decided are splits'),
    ],
  },
  {
    id: 'summary.labels',
    area: 'Records and studio',
    name: 'Labels and names: judges and `toSucceed` checks by their `expect` label in judge rates, `reeval show` and `summary.md` (a long script on one line), tokens as `430k vs 1,094k` everywhere, and a compare\u2019s control named by its environment in the digest',
    tests: [
      analysis(
        'labels and names: judges and checks go by their expect label, and the control by its environment',
      ),
      analysis("tokens read the same everywhere: Ben's 430443 vs 1093952 is 430k vs 1,094k"),
    ],
  },
  {
    id: 'query.context-use',
    area: 'Records and studio',
    name: 'Tool calls classed as context, dependency, web, verify or workspace (`context_use`), the declared files each attempt opened (`skill_files`), and the digest\u2019s `context-use` fact',
    tests: [
      query('a read of a placed file is context, by absolute path, ~ or a glob'),
      query('digging in installed packages is dependency; an exclusion of them is not'),
      query('checks, builds and the web have their own classes; the rest is workspace'),
      query('each harness opened its placed SKILL.md; web and MCP calls have their classes'),
      analysis(
        'the digest frames it as a study: criteria say what differs, never-met labels once, evidence for every arm',
      ),
    ],
  },
  {
    id: 'query.check-rates',
    area: 'Records and studio',
    name: 'Each labelled check\u2019s pass rate per cell, control and variant alike (`check_rates`)',
    tests: [
      query(
        'check_rates gives each labelled check’s pass rate per cell, on both arms of a compare',
      ),
    ],
  },
  {
    id: 'summary.judge-keys',
    area: 'Records and studio',
    name: 'Standing per-key judge pass rate on the studio eval page, with lift per key when both sides have enough counted attempts',
    tests: [
      studio('per-key judge rates, collapsed scores and cell usage'),
      studio('colliding judge prefixes take the distinctive tail'),
    ],
  },
  {
    id: 'summary.judge-score',
    area: 'Records and studio',
    name: 'Studio attempt rows show each judge as fail 0.78/0.80 (or the minimum plus a count)',
    tests: [studio('per-key judge rates, collapsed scores and cell usage')],
  },
  {
    id: 'summary.usage',
    area: 'Records and studio',
    name: 'Token usage on each attempt and a per-cell sum of counted attempts, in the studio',
    tests: [studio('per-key judge rates, collapsed scores and cell usage')],
  },
  {
    id: 'analyze',
    area: 'Records and studio',
    name: '`reeval analyze`: a digest of facts, one structured call on `analysis.model`, citation and CLI-command validation',
    tests: [
      analysis('the digest is facts with ids, evidence by rule'),
      analysis('the prompt and rules say insufficient lift is not measured'),
      analysis('the prompt and rules say a changed eval is not an effect'),
      analysis('the prompt asks for one sentence and does not self-rate checks'),
      analysis('the prompt tells the model only --tag values that appear'),
      analysis("the digest lists each eval's tags"),
      analysis('the digest includes compare-question answers'),
      analysis('the prompt and rules say compare-question rates annotate only'),
      analysis('one counted attempt a side is insufficient lift'),
      analysis('a changed eval is not comparable, not an effect'),
      analysis('a changed eval has no mixed 6/10 vs 8/9 result line'),
      analysis('--vs none analyses this run only'),
      analysis('two counted attempts can still be an effect'),
      analysis('claims with invented citations or quotes are dropped'),
      analysis('a rejected verify is dropped'),
      analysis('an anomaly that quotes a judge score the record does not have is dropped'),
      analysis('validation caps confidence when citations or commands fail'),
      analysis('verify commands must parse as reeval commands'),
      analysis('reeval run and reeval image build verify commands must select an eval of the run'),
      analysis('the spec and reeval --help name the same commands and flags'),
      analysis('without a language model or its key, it exits 2'),
    ],
  },
  {
    id: 'analyze.store',
    area: 'Records and studio',
    name: '`reeval analyze` caches in `.reeval/analysis`; `--save` writes create-only under `<run>/analysis/`; the studio Analysis tab shows them',
    tests: [
      analysis('a cached analysis makes no call; --no-cache does'),
      analysis('--save writes two new files under <run>/analysis/ and nothing else'),
    ],
  },
  {
    id: 'analysis.agent',
    area: 'Records and studio',
    name: '`analysis.agent`: `reeval run` writes a note on each eval and harness, from tools over its attempts, into `.reeval/analysis/<run>/notes/`',
    tests: [
      analysis('on made-up staged records, missing and cut-short ones too'),
      analysis('real harness transcripts and diffs read the same from a staged record'),
      analysis('on real traces, a failed canary pairs with its passing eval'),
      analysis('the analyst replays each real harness'),
      analysis('a fake run writes one note per eval and harness'),
      analysis('a note that errors is written with its error and a warning'),
      analysis('without agent, a run makes no analysis call'),
      analysis('agent without a language model exits 2 at plan time'),
      options('common mistakes'),
    ],
    real: ['questions › examples/hello --profile questions'],
  },
  {
    id: 'analysis.agent.summary',
    area: 'Records and studio',
    name: "`analysis.agent`'s run summary: once the run is written, the `reeval analyze` document for it, read with tools and cached under the same key; the studio's Analysis tab shows it, the notes, and a failed call's error",
    tests: [
      analysis('on a real Cursor history, the tools read back dropped evidence'),
      analysis('on each real harness'),
      analysis('a fake run caches one run-scoped summary'),
      analysis('a summary that fails is cached with its error and a warning'),
      studio("analysis.agent's notes are in the build as the server serves them"),
      "studio-web/test/e2e.test.ts › reeval studio shows analysis.agent's notes and summary",
    ],
    real: ['questions › examples/hello --profile questions'],
  },
  {
    id: 'ui.capture',
    area: 'Records and studio',
    name: '`c.capture()`, `c.serve` and `c.exec({ background })`',
    fixtures: [
      'ui/capture',
      'ui/capture-concurrent',
      'ui/capture-unreachable',
      'ui/capture-browser-false',
      'ui/capture-browser-env',
      'ui/capture-no-download',
      'ui/capture-wait-idle',
      'ui/capture-wait-timeout',
      'ui/background-compound',
      'ui/serve-redirect',
      'ui/serve-kill',
    ],
    plan: ['capture/options'],
    tests: [
      'reeval/test/ui.test.ts › browser-download names the binary, version, size and cache',
      'reeval/test/capture.test.ts › stub PNG bytes are unique for the capture key',
      'reeval/test/capture.test.ts › removeChromeProfile deletes a profile and ignores a busy one',
      'reeval/test/capture.test.ts › msysTreeKill stops the pid and its descendants by ppid, each Win32 pid first',
      'reeval/test/capture-wait.test.ts › resolveCaptureWait defaults to load and rejects anything else',
      'reeval/test/capture-wait.test.ts › listenForCaptureWait idle waits for networkAlmostIdle on the navigated loader',
      'reeval/test/capture-wait.test.ts › listenForCaptureWait times out naming the wait and does not resolve late',
    ],
  },
  {
    id: 'ui.capture.use',
    area: 'Records and studio',
    name: "`c.capture()` vision journey (`instructions`, `model`, `viewport: 'full-page'`)",
    fixtures: [
      'ui/capture-use',
      'ui/capture-full-page',
      'ui/capture-use-click',
      'ui/capture-use-wait',
      'ui/capture-use-timeout',
    ],
    plan: ['capture/options'],
    tests: [
      'reeval/test/capture.test.ts › resolveCaptureCall accepts full-page and a wait beat',
      'reeval/test/capture-use.test.ts › dispatchInput sends CDP Input events and never Runtime.evaluate',
      'reeval/test/capture-use.test.ts › runJourney times out before the saved screenshot',
    ],
  },
  {
    id: 'studio',
    area: 'Records and studio',
    name: '`reeval studio` and `reeval studio build`',
    tests: [
      'reeval/test/studio.test.ts › serves the app with a strict CSP',
      'reeval/test/studio.test.ts › writes a static site',
      'reeval/test/studio.test.ts › a run whose only failures are ungated is passed',
      'reeval/test/studio.test.ts › a run lead names pass, fail, infra and failed judges',
      'reeval/test/studio.test.ts › the run page leads with a verdict, then the stats',
      'reeval/test/studio.test.ts › tool calls and file edits are counted apart',
      studio('runs list: a run over a subset of cells is no drift, before or after it'),
    ],
    real: ['e2e › reeval studio build'],
  },
  {
    id: 'studio.debug',
    area: 'Records and studio',
    name: "The studio's Debug tab: an attempt's phase timeline, gateway requests and raw trace, from `.reeval/debug`, in `reeval studio` only",
    tests: [
      studio("serves an attempt's local debug data, and null where there is none"),
      studio('writes a static site with the same paths the server answers'),
      'studio-web/test/e2e.test.ts › reeval studio needs its token, then shows new runs as they land',
      'studio-web/test/e2e.test.ts › a static build works from a subpath',
    ],
  },
  {
    id: 'studio.live',
    area: 'Records and studio',
    name: "Runs in progress in `reeval studio`: `reeval run`'s `.reeval/staging/<run>/live.json`, a `Running N/M` row and progress bar, attempts filling in with their transcripts, `Stopped` for a killed run, and the record replacing it",
    tests: [
      'reeval/test/live.test.ts › starts with every planned attempt queued',
      'reeval/test/live.test.ts › is replaced whole',
      'reeval/test/live.test.ts › anything it cannot read is null',
      'reeval/test/live.test.ts › running, stopped (process gone, or quiet), corrupt and landed runs',
      'reeval/test/live.test.ts › a finished attempt serves its redacted transcript',
      'reeval/test/live.test.ts › /api/events streams run.progress',
      'reeval/test/live.test.ts › from 0/N to done, then the record replaces it',
      'reeval/test/live.test.ts › a killed run is shown as stopped',
      'studio-web/test/e2e.test.ts › reeval studio shows a run in progress attempt by attempt',
    ],
  },
  {
    id: 'studio.answers',
    area: 'Records and studio',
    name: "Compare questions' answers on the studio's run page: win rates within and across harnesses, the model, and a failed call's error",
    tests: [
      studio("compare answers: each question's win rates per cut, and nothing without one"),
      studio("compare answers over real harnesses' diffs (real-e2e-pairs)"),
      studio('writes a static site with the same paths the server answers'),
      'studio-web/test/e2e.test.ts › a static build works from a subpath',
      'studio-web/test/e2e.test.ts › every run in the record corpus renders',
      "studio-web/test/e2e.test.ts › a compare answer over real harnesses' diffs (real-e2e-pairs)",
    ],
    real: ['questions › examples/hello --profile questions'],
  },

  // CLI and runner
  {
    id: 'engine.loading',
    area: 'CLI and runner',
    name: 'Eval files load as TypeScript, ESM, CommonJS and JSON (extensionless, circular, top-level await), each file in a process of its own; a broken tsconfig or syntax error fails loudly',
    tests: [
      engine(
        'eval files mix TypeScript, ESM, CommonJS and JSON, with extensionless, circular imports and top-level await',
      ),
      engine(
        'each eval file runs in a process of its own: module state and globals never cross files',
      ),
      engine(
        "a tsconfig that isn't JSON fails every eval file loudly; comments and trailing commas are fine",
      ),
      engine('a tsconfig that extends a missing file fails every eval file loudly, once'),
      engine('.only narrows only the file it is in'),
      engine('a name declared twice in one file is a usage error naming it'),
      "reeval/test/pack.test.ts › the packed package installs with Yarn Berry's Plug'n'Play and runs reeval",
    ],
  },
  {
    id: 'harness.start-timeout',
    area: 'CLI and runner',
    name: "A harness session that doesn't become ready within `startTimeout` (default 90s) is retried once, then an infra error; its sandbox goes and the other attempts carry on",
    tests: [
      engine('never becomes ready is an infra error, once retried'),
      engine('a session that hangs once becomes ready on its retry, recorded'),
      engine('startTimeout must be a duration'),
    ],
  },
  {
    id: 'engine.failures',
    area: 'CLI and runner',
    name: 'A worker that dies, throws or runs out of memory fails its attempts; a CLI that crashes or is killed takes its workers and sandboxes with it',
    tests: [
      engine('a worker killed mid-attempt fails its attempts, names the file, and the run goes on'),
      engine('a worker that runs out of memory fails its attempts too'),
      engine(
        "an uncaught exception or unhandled rejection in an eval's worker fails the run; the other evals still finish",
      ),
      engine('mid-turn, its worker cancels, destroys the sandbox and exits'),
    ],
  },
  {
    id: 'exit-codes',
    area: 'CLI and runner',
    name: 'Exit codes 0, 1, 2, 3, 130 and 143',
    tests: [
      engine('a passing eval exits 0'),
      engine('a failing assertion exits 1'),
      engine('a harness failure is an infra error and exits 3'),
      engine('records the run and destroys the sandbox'),
      engine('an unhandled rejection in the main process mid-run prints it, redacted, and exits 3'),
    ],
  },
  {
    id: 'exit-precedence',
    area: 'CLI and runner',
    name: 'Exit code precedence (a failure and an infra error in one run)',
    tests: [engine('a failure outranks an infra error in the same run: exit 1, not 3')],
  },
  {
    id: 'output',
    area: 'CLI and runner',
    name: 'Output modes, renderers and GitHub Actions groups',
    tests: [
      'reeval/test/ui.test.ts › grouped: start lines stream',
      'reeval/test/ui.test.ts › GitHub Actions: passing attempts collapse into groups',
      engine('agent mode prints the plan and the result blocks only'),
      engine("a turn's error message shows in the summary, agent output and summary.md without -v"),
    ],
  },
  {
    id: 'output.flags',
    area: 'CLI and runner',
    name: '`--log-order`, `--log-prefix` and `--output-logs` through `reeval run`',
    tests: [engine('--log-order, --log-prefix and --output-logs shape what reeval run prints')],
  },
  {
    id: 'output.layouts',
    area: 'CLI and runner',
    name: 'Result layouts by what an eval varies: results, measure a change, compare harnesses, both, and a family',
    fixtures: ['output/none', 'output/change', 'output/harness', 'output/both', 'output/family'],
    tests: [
      'reeval/test/output.test.ts › layout() picks the shape from what the eval varies',
      'reeval/test/output.test.ts › statistics only with -v',
    ],
  },
  {
    id: 'output.not-run',
    area: 'CLI and runner',
    name: 'A check that never ran reads `not run`, never `0 of N`',
    fixtures: ['output/not-run'],
    tests: ["reeval/test/output.test.ts › a check that didn't run reads not run, never 0 of N"],
  },
  {
    id: 'output.tally',
    area: 'CLI and runner',
    name: 'The tally (`5 fail · 2 pass`, infra errors and skips apart) and the no-model hint',
    fixtures: ['output/infra-error'],
    tests: ['reeval/test/output.test.ts › the tally puts fail first'],
  },
  {
    id: 'verbose',
    area: 'CLI and runner',
    name: '`-v`/`--verbose`: the timestamped per-attempt phase trace (plan, image, container, environment, brokering, turns and tool calls, checks, judge, gateway requests, teardown)',
    tests: [
      debug('-v prints each phase line for an attempt, prefixed with the attempt'),
      debug('canary: without -v, no phase line prints'),
      debug('grouped logs keep each attempt’s debug lines in its own block'),
      debug('agent mode prints -v lines too, under the attempt tag'),
      docker('-v and -vv trace the image, container, brokering, gateway and docker commands'),
      docker("-v summarises a harness's expected blocked hosts once"),
      unit("the -v broker line names each brokered endpoint's path matcher"),
      sandboxDocker(
        'proxy',
        'reports each request once done, with bytes and names, and each DNS decision',
      ),
    ],
    real: ['e2e › reeval run --record -v'],
  },
  {
    id: 'trace',
    area: 'CLI and runner',
    name: '`-vv`/`--trace`: raw payloads, docker commands with their output, gateway headers, DNS decisions, the resolved config and environment, millisecond times',
    tests: [
      debug('-vv adds raw payloads with millisecond times'),
      docker('-v and -vv trace the image, container, brokering, gateway and docker commands'),
    ],
  },
  {
    id: 'debug.files',
    area: 'CLI and runner',
    name: 'Local debug data: `.reeval/debug/<run>/…/debug.log` always, `trace.ndjson` (a capped buffer) on failure or with `--trace`, never in the history folder',
    tests: [
      debug('debug.log is always written to .reeval/debug, and nothing of it lands in the history'),
      debug('trace.ndjson is kept for a failing attempt, not a passing one unless --trace'),
      debug('a small trace buffer drops the oldest entries and says how many'),
    ],
    real: ['e2e › reeval run --record -v'],
  },
  {
    id: 'debug.redaction',
    area: 'CLI and runner',
    name: 'Redaction of the debug trace on screen, in debug.log and in trace.ndjson, encoded forms included',
    tests: [
      debug('redaction holds on screen, in debug.log and in trace.ndjson, encoded forms included'),
      debug("a key's tail is masked on screen, in debug.log, trace.ndjson and the transcript"),
      docker('-v and -vv trace the image, container, brokering, gateway and docker commands'),
    ],
  },
  {
    id: 'debug.retention',
    area: 'CLI and runner',
    name: '`config.debug` (`keep`, `traceBufferMb`) and `reeval clean`',
    tests: [
      debug('keeps the newest debug.keep runs, and reeval clean clears them'),
      options('common mistakes'),
    ],
  },
  {
    id: 'concurrency',
    area: 'CLI and runner',
    name: 'Concurrency caps, order and queue time',
    tests: [
      'reeval/test/concurrency.test.ts › --concurrency caps attempts across files',
      'reeval/test/concurrency.test.ts › a sandbox cap holds on top of the run cap',
      'reeval/test/concurrency.test.ts › time spent queued counts toward neither',
      'reeval/test/concurrency.test.ts › --dry-run sizes the default concurrency from the Docker VM',
    ],
  },
  {
    id: 'run.resume',
    area: 'CLI and runner',
    name: '`reeval run --resume [<ref>]`: continue a stopped, interrupted or budget-stopped run with the same id',
    fixtures: ['run/resume'],
    plan: ['resume/stopped-staging'],
    tests: [
      'reeval/test/resume.test.ts › omitted ref and latest pick the newest resumable, not assembled latest',
      'reeval/test/resume.test.ts › a quiet heartbeat is still running when the pid is alive',
      'reeval/test/resume.test.ts › omitted ref names a live run instead of no resumable',
      'reeval/test/resume.test.ts › refuses a second claim while this process holds the id',
      'reeval/test/resume.test.ts › reuses the leftover id, skips a completed attempt and runs the rest',
      'reeval/test/resume.test.ts › --dry-run does not write the pointer or move an interrupted scratch',
      'reeval/test/results.test.ts › a skipped attempt keeps a staged pass',
      'reeval/test/ui.test.ts › grouped: start lines stream',
    ],
  },
  {
    id: 'cancel',
    area: 'CLI and runner',
    name: 'Eval timeouts, Ctrl-C and SIGTERM',
    tests: [
      'reeval/test/concurrency.test.ts › Ctrl-C cancels running attempts',
      'reeval/test/unit.test.ts › isTimeout is the TimeoutError name, not the message',
      'reeval/test/results.test.ts › without a record, TimeoutError is a timeout',
      'reeval/test/engine-node.test.ts › a failed result keeps the error name',
      'reeval/test/engine-run.test.ts › a timeout fails at the timeout',
      'reeval/test/engine-worker.test.ts › a cancel aborts the running attempts',
      engine('a timeout aborts the agent and destroys the sandbox'),
      engine('a turn whose agent ignores the abort is cut off shortly after the timeout'),
      engine('records the run and destroys the sandbox'),
      docker('SIGTERM to the process group mid-turn exits 143 and leaves no container'),
    ],
  },
  {
    id: 'pack',
    area: 'CLI and runner',
    name: 'The packed package installs into a clean project and runs',
    tests: ['reeval/test/pack.test.ts › the packed package installs into a clean project'],
  },
  {
    id: 'sdk.python',
    area: 'CLI and runner',
    name: 'Python eval authoring SDK (declare conformance and fake run)',
    fixtures: ['python-sdk/hello'],
    plan: ['python/hello'],
    tests: ['reeval/test/python-sdk.test.ts › Python SDK declare conformance'],
  },
]
