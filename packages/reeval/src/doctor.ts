// `reeval doctor`: checks what a run needs, each with the fix, without running anything. It names
// every key it checks and never prints a key's value.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DockerState, Engine } from '@reeval/sandbox-docker'
import type { Flags } from './cli-spec.ts'
import {
  badCharacterAt,
  configFilesPhrase,
  configLabel,
  configPathFor,
  defaultConcurrency,
  loadConfig,
  UsageError,
} from './config.ts'
import { unenforceable } from './egress.ts'
import { loadEnvFiles } from './env.ts'
import { environmentSandbox } from './environment.ts'
import { credentialOf } from './harness/agents.ts'
import { runtimeInfo } from './history/provenance.ts'
import type { Stack } from './history/types.ts'
import { fromCwd } from './ids.ts'
import { missingGitignoreEntries } from './init.ts'
import { judgeCredentials } from './judge/index.ts'
import { harnessId, sandboxId } from './options.ts'
import { redactSecrets, SECRET_NAME } from './redact.ts'
import { PACKAGE_DIR } from './root.ts'
import type { EgressPolicy, HarnessDescriptor, ResolvedConfig, SandboxDescriptor } from './types.ts'
import { colors } from './ui/colors.ts'
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

type Runtime = NonNullable<Stack['runtime']>

export type Check = {
  /** The area: runtime, config, docker, image, key, judge, egress, gitignore or env-files. */
  id: string
  status: CheckStatus
  summary: string
  fix?: string
}

/** What the checks read from the machine, replaceable in tests. */
export type DoctorDeps = {
  env: NodeJS.ProcessEnv
  runtime: Runtime
  /** `process.versions.node`: under Bun or Deno, the Node version they're compatible with. */
  nodeVersion: string
  platform: NodeJS.Platform
  dockerState: (engine?: Engine) => Promise<DockerState>
  dockerCapacity: (engine?: Engine) => Promise<{ cpus: number; memoryBytes: number } | null>
  /** Why Podman can't confine a sandbox (too old, cgroup controllers missing), or null. */
  podmanConfinement: () => Promise<{ problem: string; fix: string } | null>
  /** Whether the image is in the local Docker (or Podman). */
  imageExists: (ref: string, engine?: Engine) => Promise<boolean>
  /** `repository:tag` of every local image in a repository. */
  imageTags: (repository: string, engine?: Engine) => Promise<string[]>
  /** Which of `paths` git ignores in `root`, or null outside a git repository. */
  gitIgnored: (root: string, paths: string[]) => Promise<boolean[] | null>
  /** `.env` and `.env.*` files under `root` that git doesn't ignore, relative; null outside a repository. */
  gitVisibleEnvFiles: (root: string) => Promise<string[] | null>
  fetch: typeof fetch
}

const run = (command: string, args: string[], cwd?: string) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(command, args, { cwd, timeout: 20_000, windowsHide: true }, (error, stdout) =>
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: String(stdout),
      }),
    )
  })

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): DoctorDeps {
  const sandbox = () => import('@reeval/sandbox-docker')
  return {
    env,
    runtime: runtimeInfo(),
    nodeVersion: process.versions.node,
    platform: process.platform,
    dockerState: async (engine) => (await sandbox()).dockerState(engine),
    dockerCapacity: async (engine) => (await sandbox()).dockerCapacity(engine),
    podmanConfinement: async () =>
      (await import('./sandbox/providers.ts')).podmanConfinementProblem(),
    imageExists: async (ref, engine) => !!(await (await sandbox()).imageInfo(ref, engine)),
    imageTags: async (repository, engine = 'docker') => {
      const r = await run(engine, [
        'image',
        'ls',
        '--format',
        '{{.Repository}}:{{.Tag}}',
        repository,
      ])
      // Podman names local images `localhost/…`.
      return r.code === 0
        ? r.stdout
            .split('\n')
            .filter(Boolean)
            .map((t) => t.replace(/^localhost\//, ''))
        : []
    },
    gitIgnored: async (root, paths) => {
      if ((await run('git', ['rev-parse', '--git-dir'], root)).code !== 0) return null
      return Promise.all(
        paths.map(
          async (p) => (await run('git', ['check-ignore', '-q', '--no-index', p], root)).code === 0,
        ),
      )
    },
    gitVisibleEnvFiles: async (root) => {
      const r = await run(
        'git',
        [
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '--',
          ':(glob)**/.env',
          ':(glob)**/.env.*',
          ':(exclude,glob)**/node_modules/**',
        ],
        root,
      )
      return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null
    },
    fetch: globalThis.fetch,
  }
}

// ---- Machine -------------------------------------------------------------------------------

const newer = (version: string, min: number[]) => {
  const parts = version.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

/** The runtime reeval runs on, held to `engines` by the Node version it is or provides. */
export function checkRuntime(runtime: Runtime, nodeVersion: string): Check {
  const engines = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).engines.node
  const min = (/(\d+(?:\.\d+)*)/.exec(engines)?.[1] ?? '0').split('.').map(Number)
  const label =
    runtime.name === 'node'
      ? `node ${nodeVersion}`
      : `${runtime.name} ${runtime.version}, compatible with node ${nodeVersion}`
  const install = `install Node ${min.join('.')} or later (https://nodejs.org)`
  return newer(nodeVersion, min)
    ? { id: 'runtime', status: 'ok', summary: `${label} (reeval needs Node ${engines})` }
    : {
        id: 'runtime',
        status: 'fail',
        summary: `${label}, but reeval needs Node ${engines}`,
        fix: runtime.name === 'node' ? install : `upgrade ${runtime.name}, or ${install}`,
      }
}

// ---- Config --------------------------------------------------------------------------------

/** Every harness and sandbox a run of the config can use: the config's, then each profile's. */
export function configuredUses(config: ResolvedConfig) {
  const uses: Array<{ harness: HarnessDescriptor; sandbox: SandboxDescriptor; profile?: string }> =
    config.harness.map((harness) => ({
      harness,
      sandbox: environmentSandbox(config.environment, config.sandbox),
    }))
  for (const [name, profile] of Object.entries(config.profiles)) {
    const harnesses = profile.defaults?.harness
      ? [profile.defaults.harness].flat()
      : profile.defaults?.environment
        ? config.harness
        : []
    const sandbox = environmentSandbox(
      profile.defaults?.environment ?? config.environment,
      config.sandbox,
    )
    for (const harness of harnesses) uses.push({ harness, sandbox, profile: name })
  }
  return uses
}

export function describeConfig(config: ResolvedConfig): string {
  const profiles = Object.keys(config.profiles)
  return [
    `harness ${config.harness.map(harnessId).join(', ')}`,
    `sandbox ${sandboxId(environmentSandbox(config.environment, config.sandbox))}`,
    profiles.length ? `profiles ${profiles.join(', ')}` : 'no profiles',
  ].join(', ')
}

// ---- Docker --------------------------------------------------------------------------------

const DOCKER_FIX: Partial<Record<NodeJS.Platform, string>> = {
  linux: 'start Docker Desktop, or the Docker service (sudo systemctl start docker)',
  darwin: 'start Docker Desktop (or another Docker engine, such as OrbStack or Colima)',
  win32:
    'install or start Docker Desktop with the WSL 2 backend and Linux containers (https://docs.docker.com/desktop/setup/install/windows-install/)',
}

const PODMAN_FIX: Partial<Record<NodeJS.Platform, string>> = {
  linux:
    "install Podman 4 or later (your distribution's podman package), then check podman info works as you",
  darwin: 'start its machine: podman machine init, then podman machine start',
  win32: 'start its machine: podman machine init, then podman machine start',
}

/** The engines the config's container sandboxes run on, Docker first. */
const enginesOf = (config: ResolvedConfig): Engine[] => {
  const used = new Set(
    configuredUses(config).flatMap((u) =>
      u.sandbox.kind === 'docker' ? [u.sandbox.engine ?? 'docker'] : [],
    ),
  )
  return (['docker', 'podman'] as const).filter((e) => used.has(e))
}

/** Podman answers, is new enough, and can apply every limit; with the machine's size. */
async function checkPodman(deps: DoctorDeps): Promise<{ check: Check; running: boolean }> {
  if ((await deps.dockerState('podman')) !== 'running') {
    return {
      check: {
        id: 'podman',
        status: 'fail',
        summary:
          "isn't answering (podman info failed), and the config's podman() sandboxes need it",
        fix: PODMAN_FIX[deps.platform] ?? PODMAN_FIX.linux,
      },
      running: false,
    }
  }
  const problem = await deps.podmanConfinement()
  if (problem) {
    return {
      check: { id: 'podman', status: 'fail', summary: problem.problem, fix: problem.fix },
      running: true,
    }
  }
  const capacity = await deps.dockerCapacity('podman')
  if (!capacity) return { check: { id: 'podman', status: 'ok', summary: 'running' }, running: true }
  const gb = capacity.memoryBytes / 1024 ** 3
  const summary = `running · ${capacity.cpus} CPUs, ${gb.toFixed(1)} GB memory (default concurrency ${defaultConcurrency(capacity)})`
  return {
    check:
      gb < 4
        ? {
            id: 'podman',
            status: 'warn',
            summary: `${summary}; an attempt may use up to 4 GB`,
            fix: 'give the Podman machine more memory (podman machine set --memory), or lower podman({ memory })',
          }
        : { id: 'podman', status: 'ok', summary },
    running: true,
  }
}

export async function checkDocker(
  config: ResolvedConfig,
  deps: DoctorDeps,
): Promise<{ checks: Check[]; running: boolean; windowsContainers?: boolean }> {
  const engines = enginesOf(config)
  if (engines.includes('podman')) {
    const podman = await checkPodman(deps)
    if (!engines.includes('docker')) return { checks: [podman.check], running: podman.running }
    const docker = await checkDockerEngine(deps)
    return {
      ...docker,
      checks: [...docker.checks, podman.check],
      running: docker.running && podman.running,
    }
  }
  if (!engines.length) {
    return {
      checks: [{ id: 'docker', status: 'skip', summary: 'no sandbox in the config uses Docker' }],
      running: false,
    }
  }
  return checkDockerEngine(deps)
}

async function checkDockerEngine(
  deps: DoctorDeps,
): Promise<{ checks: Check[]; running: boolean; windowsContainers?: boolean }> {
  const state = await deps.dockerState()
  if (state === 'windows-containers') {
    return {
      checks: [
        {
          id: 'docker',
          status: 'fail',
          summary: "is running Windows containers, but reeval's sandboxes are Linux containers",
          fix: 'switch Docker Desktop to Linux containers (its tray menu: Switch to Linux containers), on the WSL 2 backend',
        },
      ],
      running: false,
      windowsContainers: true,
    }
  }
  if (state === 'down') {
    return {
      checks: [
        {
          id: 'docker',
          status: 'fail',
          summary: "isn't running, and the config's sandboxes need it",
          fix: DOCKER_FIX[deps.platform] ?? DOCKER_FIX.linux,
        },
      ],
      running: false,
    }
  }
  const capacity = await deps.dockerCapacity()
  if (!capacity) {
    return { checks: [{ id: 'docker', status: 'ok', summary: 'running' }], running: true }
  }
  const gb = capacity.memoryBytes / 1024 ** 3
  const summary = `running · ${capacity.cpus} CPUs, ${gb.toFixed(1)} GB memory (default concurrency ${defaultConcurrency(capacity)})`
  // Each attempt's container may use up to 4 GB (docker({ limits }) sets another).
  return {
    checks: [
      gb < 4
        ? {
            id: 'docker',
            status: 'warn',
            summary: `${summary}; an attempt may use up to 4 GB`,
            fix: 'give Docker more memory (Docker Desktop: Settings › Resources), or lower docker({ limits: { memory } })',
          }
        : { id: 'docker', status: 'ok', summary },
    ],
    running: true,
  }
}

/** reeval's sandbox image for each Docker harness in the config: present, missing or left from an older reeval. */
export async function checkImages(
  config: ResolvedConfig,
  deps: DoctorDeps,
): Promise<{ checks: Check[]; missing: string[] }> {
  const { imageFor } = await import('@reeval/sandbox-docker')
  const { imageTargets, reevalImages } = await import('./sandbox/images.ts')
  const targets = imageTargets(
    configuredUses(config).map((u) => ({ id: '', harness: u.harness, sandbox: u.sandbox })),
  )
  const checks: Check[] = []
  const missing: string[] = []
  for (const engine of ['docker', 'podman'] as const) {
    const own = targets.filter((t) => (t.sandbox.engine ?? 'docker') === engine)
    // Podman keeps its own images: say which store a podman() sandbox's image is missing from.
    const on = engine === 'podman' ? ', in Podman' : ''
    for (const harness of reevalImages(own)) {
      const ref = imageFor(harness)
      if (await deps.imageExists(ref, engine)) {
        checks.push({ id: 'image', status: 'ok', summary: `${ref} (${harness}${on})` })
      } else {
        missing.push(ref)
        checks.push({
          id: 'image',
          status: 'fail',
          summary: `${ref} (${harness}${on}) isn't built`,
          fix: 'reeval image build',
        })
      }
      const [repository] = ref.split(':')
      const prefix = `${repository}:${harness}-`
      // Derived images of this version (`<ref>-python-…`, from docker({ from })) are current.
      const stale = (await deps.imageTags(repository as string, engine)).filter(
        (tag) => tag.startsWith(prefix) && tag !== ref && !tag.startsWith(`${ref}-`),
      )
      if (stale.length) {
        checks.push({
          id: 'image',
          status: 'warn',
          summary: `${stale.join(', ')}: built by another reeval version, unused by this one`,
          fix: `${engine} image rm ${stale.join(' ')}`,
        })
      }
    }
  }
  for (const t of targets.filter((t) => t.sandbox.image)) {
    const ref = t.sandbox.image as string
    const engine = t.sandbox.engine ?? 'docker'
    if (!(await deps.imageExists(ref, engine))) {
      checks.push({
        id: 'image',
        status: 'fail',
        summary: `${ref} (${engine}({ image })) isn't in ${engine === 'podman' ? 'Podman' : 'Docker'}`,
        fix: `${engine} pull ${ref}, or build it`,
      })
    }
  }
  if (!checks.length)
    checks.push({ id: 'image', status: 'skip', summary: 'no reeval sandbox images to check' })
  return { checks, missing }
}

// ---- Keys ----------------------------------------------------------------------------------

/** A tiny authenticated request per key, answering only whether the key works. */
const PROBES: Record<string, (key: string) => { url: string; headers: Record<string, string> }> = {
  CURSOR_API_KEY: (key) => ({
    url: 'https://api.cursor.com/v0/me',
    headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
  }),
  ANTHROPIC_API_KEY: (key) => ({
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  }),
  GEMINI_API_KEY: (key) => ({
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: { 'x-goog-api-key': key },
  }),
  GOOGLE_GENERATIVE_AI_API_KEY: (key) => ({
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: { 'x-goog-api-key': key },
  }),
  OPENAI_API_KEY: (key) => ({
    url: 'https://api.openai.com/v1/models',
    headers: { authorization: `Bearer ${key}` },
  }),
}

/** Whether the API accepts the key, from one request; the key only goes in its headers. */
export async function probeKey(
  name: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<Pick<Check, 'status' | 'summary'>> {
  const probe = PROBES[name]?.(key)
  if (!probe) return { status: 'ok', summary: 'set (no auth check for this key)' }
  const host = new URL(probe.url).host
  try {
    const response = await fetchImpl(probe.url, {
      headers: probe.headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return { status: 'ok', summary: `set, and ${host} accepts it` }
    if (response.status === 401 || response.status === 403) {
      return { status: 'fail', summary: `set, but ${host} rejects it (HTTP ${response.status})` }
    }
    return {
      status: 'warn',
      summary: `set; ${host} answered HTTP ${response.status}, so it's unchecked`,
    }
  } catch (error) {
    return {
      status: 'warn',
      summary: `set; couldn't reach ${host} (${redactSecrets((error as Error).message)}), so it's unchecked`,
    }
  }
}

async function keyCheck(
  id: string,
  names: string[],
  who: string,
  required: boolean,
  deps: DoctorDeps,
  online: boolean,
  envFile: string,
): Promise<Check> {
  const name = names.find((n) => deps.env[n])
  if (!name) {
    const which = names.join(' or ')
    return {
      id,
      status: required ? 'fail' : 'warn',
      summary: `${which} for ${who}: not set`,
      fix: `add ${names[0]}=... to ${envFile}`,
    }
  }
  const value = deps.env[name] as string
  const at = badCharacterAt(value)
  if (at) {
    return {
      id,
      status: 'fail',
      summary: `${name} for ${who}: has whitespace or a line break in it at character ${at}`,
      fix: `set ${name} again as one line in ${envFile}`,
    }
  }
  if (!online) return { id, status: 'ok', summary: `${name} for ${who}: set` }
  const probed = await probeKey(name, value, deps.fetch)
  return {
    id,
    status: probed.status,
    summary: `${name} for ${who}: ${probed.summary}`,
    ...(probed.status === 'fail' ? { fix: `set a valid ${name} in ${envFile}` } : {}),
  }
}

/** Each agent harness's key, from the environment and `.env.local` / `.env`. */
export async function checkKeys(
  config: ResolvedConfig,
  deps: DoctorDeps,
  online: boolean,
  envFile: string,
): Promise<Check[]> {
  const byKey = new Map<string, { who: string[]; required: boolean }>()
  for (const use of configuredUses(config)) {
    const key = credentialOf(use.harness)
    if (!key) continue
    const entry = byKey.get(key) ?? { who: [], required: false }
    const who = use.profile
      ? `${harnessId(use.harness)} in profile ${use.profile}`
      : harnessId(use.harness)
    if (!entry.who.includes(who)) entry.who.push(who)
    entry.required ||= !use.profile
    byKey.set(key, entry)
  }
  if (!byKey.size)
    return [{ id: 'key', status: 'skip', summary: 'no harness in the config needs a key' }]
  return Promise.all(
    [...byKey].map(([key, { who, required }]) =>
      keyCheck('key', [key], who.join(', '), required, deps, online, envFile),
    ),
  )
}

export async function checkJudge(
  config: ResolvedConfig,
  deps: DoctorDeps,
  online: boolean,
  envFile: string,
): Promise<Check[]> {
  const models = [
    ...(config.judge.model !== undefined
      ? [{ model: config.judge.model, profile: undefined }]
      : []),
    ...Object.entries(config.profiles).flatMap(([name, p]) => {
      const model = p.defaults?.judge?.model ?? p.judge?.model
      return model !== undefined ? [{ model, profile: name }] : []
    }),
  ]
  if (!models.length) {
    return [{ id: 'judge', status: 'skip', summary: 'no judge model (c.judge needs one)' }]
  }
  return Promise.all(
    models.map(({ model, profile }) => {
      const label = typeof model === 'string' ? model : 'fakeJudge()'
      const who = profile ? `${label} in profile ${profile}` : label
      const keys = judgeCredentials(model)
      if (!keys.length)
        return { id: 'judge', status: 'ok', summary: `${who} needs no key` } as Check
      return keyCheck('judge', keys, who, !profile, deps, online, envFile)
    }),
  )
}

// ---- Egress and git ------------------------------------------------------------------------

const policyText = (policy: EgressPolicy) =>
  policy === 'allow-all'
    ? 'allow-all: the agents reach any host'
    : policy === 'deny-all'
      ? "deny-all: only each harness's own hosts"
      : `allow ${policy.allow.join(', ') || 'none'}, plus each harness's own hosts`

export function checkEgress(config: ResolvedConfig): Check[] {
  const checks: Check[] = []
  const inherited = config.egress ?? 'allow-all'
  checks.push({
    id: 'egress',
    status: 'ok',
    summary: `${policyText(inherited)}${config.egress === undefined ? ' (the default)' : ''}; evals and environments may set their own`,
  })
  for (const [name, p] of Object.entries(config.profiles)) {
    const policy = p.defaults?.egress
    if (policy !== undefined) {
      checks.push({ id: 'egress', status: 'ok', summary: `profile ${name}: ${policyText(policy)}` })
    }
  }
  for (const use of configuredUses(config)) {
    const policy =
      (use.profile ? config.profiles[use.profile]?.defaults?.egress : undefined) ?? inherited
    const where = use.profile ? `profile ${use.profile}` : 'the config'
    const problem = unenforceable({ policy, auto: [] }, use.sandbox, where)
    if (problem && !checks.some((c) => c.summary === problem)) {
      checks.push({ id: 'egress', status: 'fail', summary: problem })
    }
  }
  return checks
}

export async function checkGitignore(root: string, deps: DoctorDeps): Promise<Check> {
  const ignored = await deps.gitIgnored(root, ['.env', '.env.local', '.reeval/runs'])
  let missing: string[]
  if (ignored) {
    missing = [...(ignored[0] && ignored[1] ? [] : ['.env*']), ...(ignored[2] ? [] : ['.reeval/'])]
  } else {
    const path = join(root, '.gitignore')
    const absent = missingGitignoreEntries(existsSync(path) ? readFileSync(path, 'utf8') : '')
    missing = ['.env*', '.reeval/'].filter((e) => absent.includes(e))
  }
  if (!missing.length) {
    return { id: 'gitignore', status: 'ok', summary: '.env* and .reeval/ are ignored' }
  }
  const keys = missing.includes('.env*')
  return {
    id: 'gitignore',
    status: keys ? 'fail' : 'warn',
    summary: `${missing.join(' and ')} ${missing.length === 1 ? "isn't" : "aren't"} ignored${keys ? ': a commit could include your keys' : ''}`,
    fix: `add ${missing.join(' and ')} to .gitignore (reeval init adds them)`,
  }
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
/** Values that stand for a key rather than being one: `<key>`, `your-key-here`, `${KEY}`, `xxx`. */
const PLACEHOLDER =
  /^(?:<[^>]*>|\[[^\]]*\]|\$\{?[A-Za-z_]\w*\}?|\.{3}|…|[x*]{3,}|(?:your|my|replace|change|insert|put|add|enter|paste|set)\b.*|.*[-_ ]here|changeme|placeholder|todo|tbd|example|dummy|none|null|false|true|0)$/i

/** The secret-named variables `text` sets to something other than empty or a placeholder. */
export function filledSecrets(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_LINE.exec(line)
    if (!m || !SECRET_NAME.test(m[1] as string)) continue
    let value = (m[2] as string).trim()
    const quote = /^(["'`])(.*)\1/.exec(value)
    value = quote ? (quote[2] as string) : value.replace(/(?:^|\s+)#.*$/, '')
    if (value && !PLACEHOLDER.test(value.trim())) names.push(m[1] as string)
  }
  return names
}

/**
 * `.env.example` and the like, which git sees on purpose, holding real-looking values for key
 * variables: a commit shares them, and a dirty run's `worktree.patch` carries them.
 */
export async function checkEnvFiles(root: string, deps: DoctorDeps): Promise<Check | null> {
  const files = await deps.gitVisibleEnvFiles(root)
  if (!files?.length) return null
  const filled = files.flatMap((file) => {
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      return []
    }
    const names = filledSecrets(text)
    return names.length ? [{ file, names }] : []
  })
  if (!filled.length) {
    return {
      id: 'env-files',
      status: 'ok',
      summary: `${files.join(', ')}: no key values filled in`,
    }
  }
  const listed = filled.map((f) => `${f.file} (${f.names.join(', ')})`).join(', ')
  return {
    id: 'env-files',
    status: 'warn',
    summary: `${listed} ${filled.length === 1 ? 'has' : 'have'} key values filled in, and git sees ${filled.length === 1 ? 'it' : 'them'}: a commit, or a dirty run's worktree.patch, would carry them`,
    fix: 'put the values in .env.local (ignored), and leave them empty in the example file',
  }
}

// ---- The command ---------------------------------------------------------------------------

export type DoctorReport = {
  healthy: boolean
  problems: number
  warnings: number
  config: string | null
  checks: Check[]
}

/** Every check, in order; the config's checks only when it loads. */
export async function doctor(
  flags: Flags,
  deps: DoctorDeps,
): Promise<{ report: DoctorReport; config?: ResolvedConfig; missingImages: string[] }> {
  const checks: Check[] = [checkRuntime(deps.runtime, deps.nodeVersion)]
  let configPath: string | undefined
  let config: ResolvedConfig | undefined
  let missingImages: string[] = []
  let ambiguous: string | undefined
  try {
    configPath = configPathFor(flags.config)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    ambiguous = error.message
  }
  if (ambiguous) {
    checks.push({ id: 'config', status: 'fail', summary: ambiguous, fix: 'delete one of them' })
  } else if (!configPath) {
    checks.push({
      id: 'config',
      status: 'fail',
      summary: `no ${configFilesPhrase()} here or above`,
      fix: 'reeval init',
    })
  } else {
    try {
      config = await loadConfig(configPath, 'doctor')
      checks.push({
        id: 'config',
        status: 'ok',
        summary: `${configLabel(configPath)}: ${describeConfig(config)}`,
      })
    } catch (error) {
      checks.push({
        id: 'config',
        status: 'fail',
        summary: redactSecrets((error as Error).message),
        fix: `edit ${configLabel(configPath)}, then reeval run --dry-run`,
      })
    }
  }
  if (config) {
    loadEnvFiles(configPath)
    const envFile = fromCwd(join(config.root, '.env.local')) || '.env.local'
    const docker = await checkDocker(config, deps)
    checks.push(...docker.checks)
    if (docker.running) {
      const images = await checkImages(config, deps)
      checks.push(...images.checks)
      missingImages = images.missing
    } else if (docker.checks[0]?.status === 'fail') {
      const why = docker.windowsContainers
        ? 'Docker runs Windows containers'
        : `${docker.checks[0]?.id === 'podman' ? 'Podman' : 'Docker'} isn't running`
      checks.push({ id: 'image', status: 'skip', summary: why })
    }
    const online = !!flags.online
    checks.push(...(await checkKeys(config, deps, online, envFile)))
    checks.push(...(await checkJudge(config, deps, online, envFile)))
    checks.push(...checkEgress(config))
    checks.push(await checkGitignore(config.root, deps))
    const envFiles = await checkEnvFiles(config.root, deps)
    if (envFiles) checks.push(envFiles)
  }
  const problems = checks.filter((c) => c.status === 'fail').length
  const warnings = checks.filter((c) => c.status === 'warn').length
  return {
    report: {
      healthy: problems === 0,
      problems,
      warnings,
      config: configPath ? configLabel(configPath) : null,
      checks,
    },
    config,
    missingImages,
  }
}

export function renderReport(report: DoctorReport, color: boolean): string[] {
  const { green, red, yellow, dim } = colors(color)
  const mark = { ok: green('✓'), warn: yellow('!'), fail: red('✗'), skip: dim('-') }
  const width = Math.max(...report.checks.map((c) => c.id.length))
  const lines = [`reeval doctor${report.config ? ` · ${report.config}` : ''}`]
  for (const c of report.checks) {
    const text = c.status === 'skip' ? dim(c.summary) : c.summary
    lines.push(`${mark[c.status]} ${c.id.padEnd(width)}  ${text}`)
    if (c.fix) lines.push(`  ${' '.repeat(width)}  ${dim(`fix: ${c.fix}`)}`)
  }
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  lines.push(
    '',
    report.problems
      ? red(
          `${count(report.problems, 'problem')}, ${count(report.warnings, 'warning')}. Fix ${report.problems === 1 ? 'it' : 'them'} and run reeval doctor again.`,
        )
      : report.warnings
        ? yellow(`No problems, ${count(report.warnings, 'warning')}.`)
        : green('No problems.'),
  )
  return lines
}

export type DoctorIO = {
  out: (line: string) => void
  color: boolean
  /** Asks a yes/no question in a terminal; undefined when there's none. */
  confirm?: (question: string) => Promise<boolean>
}

/** `reeval doctor`: exit 0 when nothing failed, 1 otherwise. */
export async function doctorCommand(
  flags: Flags,
  io: DoctorIO,
  deps = defaultDeps(),
): Promise<number> {
  const { report, config, missingImages } = await doctor(flags, deps)
  if (flags.json) {
    io.out(JSON.stringify(report, null, 2))
    return report.healthy ? 0 : 1
  }
  for (const line of renderReport(report, io.color)) io.out(line)
  if (config && missingImages.length && io.confirm) {
    const build = await io.confirm(
      `Build ${missingImages.join(', ')} now with reeval image build? [y/N] `,
    )
    if (build) {
      const { buildImages, imageTargets } = await import('./sandbox/images.ts')
      const targets = imageTargets(
        configuredUses(config).map((u) => ({ id: '', harness: u.harness, sandbox: u.sandbox })),
      )
      const built = await buildImages(targets, config.root, { log: (line) => io.out(line) })
      for (const b of built) if (!b.ok) io.out(`✗ ${b.id}: ${b.failure.message.split('\n')[0]}`)
      io.out(
        built.every((b) => b.ok)
          ? 'Built. Run reeval doctor again to check.'
          : 'Some images failed to build; reeval image build shows why.',
      )
    }
  }
  return report.healthy ? 0 : 1
}
