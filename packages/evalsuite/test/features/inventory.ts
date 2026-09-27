// Every user-facing feature of ES, and what covers it on each tier. The feature matrix
// (COVERAGE.md, `pnpm features:matrix`) is generated from this, the fixture table in
// features.test.ts and the plan cases in plan.test.ts; matrix.test.ts fails when a feature has
// nothing on any tier and isn't a known gap, when a fixture or plan case covers no feature, or
// when an entry names something that doesn't exist. Seeded from test-strategy.md §1.

export type InventoryFeature = {
  /** Stable, dotted, e.g. `skill.git`. */
  id: string
  area: Area
  /** The feature as the docs name it. */
  name: string
  /** Directories under test/features/. Their tiers (fake, docker, real) come from features.test.ts. */
  fixtures?: string[]
  /** Plan cases in plan.test.ts, as `dir/name`. */
  plan?: string[]
  /**
   * Plain `node:test` cases (the unit tier, including runner-level tests through the CLI), as
   * `<path under packages/> › <the test's title, or a part of it>`.
   */
  tests?: string[]
  /**
   * Checks in the real-agent suites, on every real harness: `contract › <behaviour>` (a behaviour
   * in contract.test.ts) or `e2e › <the test's title, or a part of it>` (e2e-real.test.ts).
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

const unit = (name: string) => `evalsuite/test/unit.test.ts › ${name}`
const options = (name: string) => `evalsuite/test/options.test.ts › ${name}`
const engine = (name: string) => `evalsuite/test/engine.test.ts › ${name}`
const secrets = (name: string) => `evalsuite/test/secrets.test.ts › ${name}`
const harness = (name: string) => `evalsuite/test/harness.test.ts › ${name}`
const docker = (name: string) => `evalsuite/test/docker.test.ts › ${name}`
const debug = (name: string) => `evalsuite/test/debug.test.ts › ${name}`
const studio = (name: string) => `evalsuite/test/studio.test.ts › ${name}`
const analysis = (name: string) => `evalsuite/test/analysis.test.ts › ${name}`
const sandboxDocker = (file: string, name: string) =>
  `sandbox-docker/test/${file}.test.ts › ${name}`
const cursorAdapter = (file: string, name: string) =>
  `harness-cursor-sdk/test/${file}.test.ts › ${name}`
const opencodeAdapter = (file: string, name: string) =>
  `harness-opencode/test/${file}.test.ts › ${name}`
const gooseAdapter = (file: string, name: string) => `harness-goose/test/${file}.test.ts › ${name}`
const piAdapter = (file: string, name: string) => `harness-pi/test/${file}.test.ts › ${name}`

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
    tests: [options('common mistakes'), engine('usage errors exit 2')],
  },
  {
    id: 'config.dotenv',
    area: 'Config and selection',
    name: '`.env` and `.env.local` loading',
    tests: [engine('.env.local wins over .env, the shell wins over both, and evals see them')],
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
    name: 'Option cascade through groups and evals; harness edit functions',
    tests: [
      engine('groups nest, cascade options'),
      options('groups replace the harness list, evals can edit it'),
    ],
  },
  {
    id: 'compare',
    area: 'Config and selection',
    name: '`compare`: control, variants, lift and `minLift`',
    plan: ['compare/control-and-variants'],
    tests: [
      options('variants run next to the control, lift is stored'),
      'evalsuite/test/results.test.ts › Newcombe',
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
    id: 'gate',
    area: 'Config and selection',
    name: "`gate` (`'all'`, `{ passRate }`) and `compare.gate`",
    tests: [
      'evalsuite/test/results.test.ts › the option takes all or { passRate }',
      options('a config-level gate applies to every eval'),
    ],
  },
  {
    id: 'profiles',
    area: 'Config and selection',
    name: 'Profiles: `defaults`, `limit`, `pin`, selection and typos',
    plan: ['profiles/local-none', 'profiles/pr-in-ci', 'profiles/nightly'],
    tests: [
      unit('selectProfile: --profile, then ES_PROFILE'),
      unit('cascade: profile defaults sit under evals'),
      options('a profile name typo exits 2'),
    ],
  },
  {
    id: 'profiles.max-variants',
    area: 'Config and selection',
    name: '`limit.compare.maxVariants`',
    plan: ['compare/max-variants'],
  },
  {
    id: 'plan.json',
    area: 'Config and selection',
    name: '`es run --dry-run` and `--dry-run --json`',
    plan: ['matrix/default'],
    tests: [
      'evalsuite/test/plan.test.ts › is one document with the host-dependent fields',
      'evalsuite/test/plan.test.ts › --json without --dry-run exits 2',
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
    id: 'selection.modes',
    area: 'Config and selection',
    name: '`evaluate.only`, `.skip`, `.todo` and `.for`; `group.only`',
    plan: ['selection/only-local'],
    tests: [
      options('.only runs alone locally and exits 2 in CI'),
      options('tags filter, todo, for'),
      options('common mistakes'),
      engine('skip is reported as skipped'),
      'evalsuite/test/plan.test.ts › .only in CI exits 2 before any plan prints',
    ],
  },
  {
    id: 'selection.group-skip',
    area: 'Config and selection',
    name: '`group.skip` and `group.todo`',
    plan: ['selection/only-local'],
    tests: [
      engine("a skipped group's evals, nested ones too, are recorded as skipped and never run"),
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
    plan: ['compare/mixed-filter'],
    tests: [
      engine('filters match paths, then eval names'),
      engine('a path filter and a cell filter together run only that cell of that file'),
      options('a filter that matches nothing exits 2'),
      "evalsuite/test/plan.test.ts › a cell filter narrows each row's counts in the text plan",
      'evalsuite/test/plan.test.ts › a filter part that matches no file, eval name or cell exits 2',
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
      'harness/pi-workspace-skills',
    ],
  },
  {
    id: 'skill.git',
    area: 'Environments',
    name: '`skill.git`: ref, `path`, `only` and the recorded commit',
    fixtures: ['skills/git-ref'],
    tests: [unit('git refs and repo shorthands'), options('skills come from a git URL at a ref')],
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
      'evalsuite/test/harness.test.ts › resolves to an SSE server and reaches every harness in its SSE shape',
      'evalsuite/test/plan.test.ts › an mcp.sse server on Goose or pi exits 2 at plan time',
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
    name: '`rules`: `AGENTS.md` for Cursor, Antigravity, OpenCode, Goose and pi, `CLAUDE.md` for Claude Code',
    fixtures: [
      'env/rules',
      'harness/cursor-rules',
      'harness/claude-code-rules',
      'harness/antigravity-rules',
      'harness/opencode-rules',
      'harness/goose-rules',
      'harness/pi-rules',
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
    name: 'Secrets masked in everything ES writes',
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
    name: '`extend`, overrides and the environment digest',
    fixtures: ['env/setup-order'],
    tests: [unit('layered environments and overrides'), harness('one environment has one digest')],
  },
  {
    id: 't.sandbox',
    area: 'Environments',
    name: '`t.sandbox()`: checks without a turn',
    fixtures: ['env/files-home', 'skills/workspace-placement'],
  },

  // Sandbox
  {
    id: 'docker.run',
    area: 'Sandbox',
    name: 'Docker: run, diff, and removal, on timeout too',
    tests: [
      docker('runs checks in the container, diffs, and removes it'),
      docker('a timeout removes the container'),
      docker("npm installs the packed ES tarball in ES's image"),
    ],
  },
  {
    id: 'sandbox.contract',
    area: 'Sandbox',
    name: 'Sandbox `exec`, `readFile`, `writeFile` and `~/`, fake and Docker',
    tests: [
      'evalsuite/test/sandbox-contract.test.ts › writeFile then exec reads it',
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
    name: '`docker({ dockerfile })` and `ES_BASE`',
    fixtures: [
      'harness/claude-code-dockerfile',
      'harness/antigravity-dockerfile',
      'harness/opencode-dockerfile',
      'harness/goose-dockerfile',
      'harness/pi-dockerfile',
    ],
    plan: ['images/install-from-dockerfile'],
    tests: [
      docker('dockerfile: FROM the ES_BASE arg'),
      sandboxDocker('unit', 'the Dockerfile tag hashes the Dockerfile'),
    ],
  },
  {
    id: 'docker.from',
    area: 'Sandbox',
    name: '`docker({ from })` toolchain images',
    tests: [
      options('es image build --dry-run lists every image'),
      docker('from: a toolchain image gets Node, git and the harness baked on'),
    ],
  },
  {
    id: 'image.build',
    area: 'Sandbox',
    name: '`es image build` and `--dry-run`',
    tests: [options('es image build --dry-run lists every image')],
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
      'evalsuite/test/docker-antigravity.test.ts › Antigravity attempts broker the key on its model endpoint only',
      docker('Goose gets the key on the model list it fetches each turn'),
      docker('Gemini refusing the key fails the turn and names the host variable'),
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
      'evalsuite/test/concurrency.test.ts › timeouts under concurrency fail every attempt and destroy every sandbox',
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
    name: '`opencode()`: OpenCode over ACP on a brokered Gemini key, its image, rules, skills and tool names',
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
      opencodeAdapter('stream', 'names a call from its first update, and drops the usage'),
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
    name: '`pi()`: pi in the sandbox (`pi --mode json`) on a brokered Gemini key, with per-call tokens; MCP refused',
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
      harness('pi has no MCP client, so MCP servers are refused, naming them'),
      harness("pi's adapter brokers only the Gemini key, as GEMINI_API_KEY, to the Gemini API"),
      piAdapter(
        'stream',
        'a real multi-call turn: tool calls, results, one step per model call and their summed tokens',
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
    id: 'harness.usage',
    area: 'Harnesses',
    name: 'Token usage and the served model, per turn and totalled, from any harness',
    fixtures: ['harness/cursor-reports-usage'],
    tests: [harness('token usage and the served model, from any harness')],
    real: [
      'contract › tokens recorded where the harness reports them',
      'contract › served model recorded',
    ],
  },
  {
    id: 'harness.web-events',
    area: 'Harnesses',
    name: "Web search and fetch events (Cursor's recovered from its stored conversation), `turn.unreported`, `toHaveSearched` and `toHaveFetched`",
    fixtures: ['harness/cursor-web-fetch'],
    tests: [
      harness('web calls the runner recovers survive the adapter, HarnessAgent and the normaliser'),
      harness('SDK 1.0.32 loses them before our first layer'),
      harness("a Cursor turn is unreported for the web tools the runner couldn't recover"),
      cursorAdapter('stream', 'a real web turn on SDK 1.0.32'),
      cursorAdapter('stream', "the runner's recovered web calls"),
      cursorAdapter('unit', 'storedWebCalls: a live stored conversation'),
      cursorAdapter(
        'unit',
        'the live conversation from SDK 1.0.32 has every field the runner reads',
      ),
      cursorAdapter('unit', 'each field it reads, gone or renamed, is named in the problem'),
      "evalsuite/test/cursor-sdk-shape.test.ts › the image's @cursor/sdk declares every field the runner reads",
      'evalsuite/test/replay.test.ts › upstream fixed, same ids: each web call once',
      'evalsuite/test/replay.test.ts › upstream fixed, other ids: each web call once',
      'evalsuite/test/matchers.test.ts › refuse a turn whose harness',
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
      "evalsuite/test/replay.test.ts › ES's normaliser still finds its signals",
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
      'evalsuite/test/replay.test.ts › the same tool calls, text and tokens as when it was captured',
      'evalsuite/test/replay.test.ts › a new event kind, step type, key or tool is a format change',
    ],
    real: ['contract › native stream format unchanged'],
  },
  {
    id: 'record.served-model',
    area: 'Harnesses',
    name: "The models a harness's API requests named on the wire (`servedModels`)",
    tests: ['evalsuite/test/harness.test.ts › its brokered requests name the served model'],
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
        't.judge with an empty question or a threshold outside 0…1 fails without asking the judge',
      ),
      unit('judge calls retry transient provider errors'),
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
      'evalsuite/test/matchers.test.ts › passes when the file exists',
      'evalsuite/test/matchers.test.ts › passes on exit 0',
      'evalsuite/test/matchers.test.ts › passes on a pass verdict',
      engine('an unawaited toHaveFile or toSucceed fails its eval, and runs before teardown'),
      engine('a failure with megabytes of output prints and records a bounded tail'),
    ],
  },

  // Records and studio
  {
    id: 'history',
    area: 'Records and studio',
    name: 'Recording, merges across branches, rebases and `es checkout`',
    tests: [
      'evalsuite/test/history.test.ts › es run writes scratch; es record promotes it',
      'evalsuite/test/history.test.ts › two branches record, merge with zero conflicts',
      'evalsuite/test/history.test.ts › a dirty run saves worktree.patch',
    ],
  },
  {
    id: 'history.commands',
    area: 'Records and studio',
    name: '`es history`, `es show` and `es compare`, with `--json` and `--md`',
    tests: [
      'evalsuite/test/history.test.ts › es run writes scratch; es record promotes it',
      'evalsuite/test/history.test.ts › an imported helper is part of the fingerprint',
      unit('compare classifies an eval on the cells both runs have, and lists the rest'),
      'evalsuite/test/history.test.ts › a history file that is not a readable record is named on stderr',
      docker('two runs with the same agent context are comparable'),
    ],
    real: ['e2e › a second identical run', 'e2e › es history and es show'],
  },
  {
    id: 'compare.fail-on-regression',
    area: 'Records and studio',
    name: '`es compare --fail-on-regression`',
    tests: [
      'evalsuite/test/history.test.ts › es compare --fail-on-regression fails on a regression and on a failing new eval',
    ],
  },
  {
    id: 'query',
    area: 'Records and studio',
    name: '`es query`',
    tests: ['evalsuite/test/query.test.ts › the projection matches the record'],
    real: ['e2e › es query'],
  },
  {
    id: 'query.facts',
    area: 'Records and studio',
    name: '`es query` facts views: `effort`, `factor_effects` (controlled, pooled, observed, not measured), `skill_reads` and `tool_calls`, `attempt_context`',
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
      'evalsuite/test/query.test.ts › drift names the changed part',
    ],
  },
  {
    id: 'effort',
    area: 'Records and studio',
    name: 'Effort (tool calls, agent time) next to lift in the `es run` summary, `summary.md`, `es compare` and the studio',
    tests: [
      analysis('the rank test is exact'),
      analysis('es run, summary.md and es compare show each variant cell'),
      unit('effort under 10s reads in tenths, so a ratio matches its times'),
    ],
  },
  {
    id: 'analyze',
    area: 'Records and studio',
    name: '`es analyze`: a digest of facts, one structured call on `analysis.model`, citation and CLI-command validation',
    tests: [
      analysis('the digest is facts with ids, evidence by rule'),
      analysis('claims with invented citations or quotes are dropped'),
      analysis('verify commands must parse as ES commands'),
      analysis('es run and es image build verify commands must select an eval of the run'),
      analysis('the spec and es --help name the same commands and flags'),
      analysis('without a language model or its key, it exits 2'),
    ],
  },
  {
    id: 'analyze.store',
    area: 'Records and studio',
    name: '`es analyze` caches in `.es/analysis`; `--save` writes create-only under `<run>/analysis/`; the studio Analysis tab shows them',
    tests: [
      analysis('a cached analysis makes no call; --no-cache does'),
      analysis('--save writes two new files under <run>/analysis/ and nothing else'),
    ],
  },
  {
    id: 'studio',
    area: 'Records and studio',
    name: '`es studio` and `es studio build`',
    tests: [
      'evalsuite/test/studio.test.ts › serves the app with a strict CSP',
      'evalsuite/test/studio.test.ts › writes a static site',
      'evalsuite/test/studio.test.ts › a run whose only failures are ungated is passed',
      'evalsuite/test/studio.test.ts › tool calls and file edits are counted apart',
      studio('runs list: a run over a subset of cells is no drift, before or after it'),
    ],
    real: ['e2e › es studio build'],
  },
  {
    id: 'studio.debug',
    area: 'Records and studio',
    name: "The studio's Debug tab: an attempt's phase timeline, gateway requests and raw trace, from `.es/debug`, in `es studio` only",
    tests: [
      studio("serves an attempt's local debug data, and null where there is none"),
      studio('writes a static site with the same paths the server answers'),
      'studio-web/test/e2e.test.ts › es studio needs its token, then shows new runs as they land',
      'studio-web/test/e2e.test.ts › a static build works from a subpath',
    ],
  },

  // CLI and runner
  {
    id: 'exit-codes',
    area: 'CLI and runner',
    name: 'Exit codes 0, 1, 2, 3, 130 and 143',
    tests: [
      engine('a passing eval exits 0'),
      engine('a failing assertion exits 1'),
      engine('a harness failure is an infra error and exits 3'),
      engine('records the run and destroys the sandbox'),
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
      'evalsuite/test/ui.test.ts › grouped: start lines stream',
      'evalsuite/test/ui.test.ts › GitHub Actions: passing attempts collapse into groups',
      engine('agent mode prints failures only'),
      engine("a turn's error message shows in the summary, agent output and summary.md without -v"),
    ],
  },
  {
    id: 'output.flags',
    area: 'CLI and runner',
    name: '`--log-order`, `--log-prefix` and `--output-logs` through `es run`',
    tests: [engine('--log-order, --log-prefix and --output-logs shape what es run prints')],
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
    real: ['e2e › es run --record -v'],
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
    name: 'Local debug data: `.es/debug/<run>/…/debug.log` always, `trace.ndjson` (a capped buffer) on failure or with `--trace`, never in the history folder',
    tests: [
      debug('debug.log is always written to .es/debug, and nothing of it lands in the history'),
      debug('trace.ndjson is kept for a failing attempt, not a passing one unless --trace'),
      debug('a small trace buffer drops the oldest entries and says how many'),
    ],
    real: ['e2e › es run --record -v'],
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
    name: '`config.debug` (`keep`, `traceBufferMb`) and `es clean`',
    tests: [
      debug('keeps the newest debug.keep runs, and es clean clears them'),
      options('common mistakes'),
    ],
  },
  {
    id: 'concurrency',
    area: 'CLI and runner',
    name: 'Concurrency caps, order and queue time',
    tests: [
      'evalsuite/test/concurrency.test.ts › --concurrency caps attempts across files',
      'evalsuite/test/concurrency.test.ts › a sandbox cap holds on top of the run cap',
      'evalsuite/test/concurrency.test.ts › time spent queued counts toward neither',
      'evalsuite/test/concurrency.test.ts › --dry-run sizes the default concurrency from the Docker VM',
    ],
  },
  {
    id: 'cancel',
    area: 'CLI and runner',
    name: 'Eval timeouts, Ctrl-C and SIGTERM',
    tests: [
      'evalsuite/test/concurrency.test.ts › Ctrl-C cancels running attempts',
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
    tests: ['evalsuite/test/pack.test.ts › the packed package installs into a clean project'],
  },
]
