import { readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'
import { z } from 'zod'
import { sandboxProblem } from './contract/docker.ts'
import { environmentDataSchema, environmentSpecSchema, NAME } from './contract/environment.ts'
import {
  badHost,
  descriptorProblem,
  egressProblem,
  gitWorkspaceSchema,
  hostFileSchema,
  mcpServerSchema,
  pluginSourceSchema,
  secretSchema,
  skillSourceSchema,
  VAR,
} from './contract/plain.ts'
import { closest, genericProblem, got, type Issue, refusal } from './contract/shared.ts'
import { parseDuration } from './duration.ts'
import { localPluginServers, PLUGIN_PARTS } from './environment/plugins.ts'
import { isObjectLike } from './object.ts'
import { SECRET_NAME } from './redact.ts'
import { COMPILED, PACKAGE_DIR } from './root.ts'
import type {
  EgressPolicy,
  Environment,
  EnvironmentData,
  EnvironmentHelpers,
  EnvironmentInput,
  EnvironmentLayer,
  EnvironmentSpec,
  EnvVars,
  GitHelper,
  GitWorkspace,
  HostFile,
  McpHelper,
  McpServer,
  PluginHelper,
  PluginPart,
  SandboxDescriptor,
  Secret,
  SecretHelper,
  SecretOptions,
  SecretTemplate,
  SkillHelper,
  SubstituteIn,
} from './types.ts'

export class DefinitionError extends Error {
  override name = 'DefinitionError'
}

const SPEC_KEYS = [
  'sandbox',
  'workspace',
  'env',
  'egress',
  'files',
  'rules',
  'setup',
  'skills',
  'mcp',
  'plugins',
]
/** Image fields that belong on `sandbox: docker({ … })`, not as sibling keys. */
const SANDBOX_KEYS = ['image', 'install', 'dockerfile', 'from']
const SPEC_HINTS: Record<string, string> = {
  exec: 'setup',
  steps: 'setup',
  run: 'setup',
  vars: 'env',
  secrets: 'env',
  network: 'egress',
  networkPolicy: 'egress',
  skill: 'skills',
  plugin: 'plugins',
  file: 'files',
  agents: 'rules',
  use: 'extend',
  repo: 'workspace',
  git: 'workspace',
  template: 'workspace',
}

export const isSecret = (value: unknown): value is Secret =>
  isObjectLike(value) && value.kind === 'secret'

export const isSecretTemplate = (value: unknown): value is SecretTemplate =>
  isObjectLike(value) && value.kind === 'secret-template'

export const isHostFile = (value: unknown): value is HostFile =>
  isObjectLike(value) && value.kind === 'file'

export const isEnvironment = (value: unknown): value is Environment =>
  isObjectLike(value) && value.kind === 'environment' && Array.isArray(value.layers)

// reeval's own files, so a stack trace's first frame outside them is the file that called us.
// Compiled, all of reeval's code is one module at the root of the executable's filesystem.
const OWN_DIRS = COMPILED
  ? [join(PACKAGE_DIR, sep)]
  : ['src', 'dist'].map((dir) => join(PACKAGE_DIR, dir, sep))

/** The directory of the file that called into reeval, from the stack; relative paths resolve here. */
export function callerDir(): string | undefined {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 30
  const stack = new Error().stack ?? ''
  Error.stackTraceLimit = limit
  for (const line of stack.split('\n').slice(1)) {
    const match = /(?:\(|at )((?:file:\/\/)?\/[^()]*?|[A-Za-z]:[\\/][^()]*?):\d+:\d+\)?\s*$/.exec(
      line,
    )
    if (!match?.[1]) continue
    // Native separators: transformed files' frames say C:/… on Windows.
    const file = normalize(match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1])
    if (OWN_DIRS.some((d) => file.startsWith(d)) || file.includes(`${sep}node_modules${sep}`))
      continue
    return dirname(file)
  }
  return undefined
}

/** A path as written, or a `file:` URL, made absolute against `base`. */
export const toPath = (value: string | URL, base: string) => {
  const path = value instanceof URL ? fileURLToPath(value) : value
  return isAbsolute(path) ? path : resolve(base, path)
}

/**
 * A tarball or folder spec (`./x.tgz`, `../pkg`, `/abs`, `file:…`) as an absolute path, resolved
 * like `file()`; npm resolves relative ones against its working directory, reeval's cache.
 */
export const localNpmSpec = (spec: string, base: string) => {
  const path = spec.startsWith('file:') ? spec.slice('file:'.length) : spec
  return /^\.{1,2}(?:\/|$)/.test(path) || isAbsolute(path) ? toPath(path, base) : spec
}

const SUBSTITUTE_IN: readonly SubstituteIn[] = ['header', 'query', 'body']

/** Throws unless `value` is `'allow-all'`, `'deny-all'` or `{ allow: [hosts] }`. */
export function checkEgress(
  value: unknown,
  where: string,
  Err: new (message: string) => Error = DefinitionError,
): asserts value is EgressPolicy {
  const problem = egressProblem(value, where)
  if (problem) throw new Err(problem)
}

export const SECRET_HOSTS: SecretHelper['hosts'] = Object.freeze({
  gemini: Object.freeze(['generativelanguage.googleapis.com']),
  openai: Object.freeze(['api.openai.com']),
  anthropic: Object.freeze(['api.anthropic.com']),
  github: Object.freeze(['api.github.com', 'uploads.github.com']),
})

function secretOptions(options: SecretOptions, what: string): Omit<Secret, 'kind' | 'from'> {
  const to = options.to ?? 'agent'
  if (to !== 'agent' && to !== 'checks') {
    throw new DefinitionError(`${what}: to is 'agent' or 'checks' (got ${JSON.stringify(to)})`)
  }
  const { hosts } = options
  if (hosts !== undefined) {
    if (!Array.isArray(hosts) || hosts.length === 0) {
      throw new DefinitionError(
        `${what}: hosts must list the hosts the secret is sent to, e.g. hosts: ['api.example.com'] or secret.hosts.gemini (got ${JSON.stringify(hosts)})`,
      )
    }
    for (const host of hosts) {
      const bad = badHost(host)
      if (bad) throw new DefinitionError(`${what}: ${bad}`)
    }
  }
  if (options.in !== undefined) {
    if (hosts === undefined) {
      throw new DefinitionError(
        `${what}: in only applies to a brokered secret; add hosts, e.g. { hosts: ['api.example.com'], in: ${JSON.stringify(options.in)} }`,
      )
    }
    const bad = Array.isArray(options.in)
      ? options.in.filter((i) => !SUBSTITUTE_IN.includes(i))
      : [options.in]
    if (bad.length || options.in.length === 0) {
      throw new DefinitionError(
        `${what}: in lists where the gateway substitutes: 'header', 'query' and/or 'body' (got ${JSON.stringify(options.in)})`,
      )
    }
  }
  return {
    ...(options.optional ? { optional: true } : {}),
    ...(to === 'checks' ? { to } : {}),
    ...(hosts ? { hosts: [...hosts] } : {}),
    ...(options.in ? { in: [...new Set(options.in)] } : {}),
  }
}

/** Where an MCP server's header secrets are brokered to by default: its own host, over HTTPS. */
export function mcpHosts(url: string): string[] | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? [u.hostname] : undefined
  } catch {
    return undefined
  }
}

/**
 * A secret an attempt puts in the sandbox: where it's set (`KEY`, `mcp.docs.headers.auth`), the
 * host variable it reads, and the hosts it's brokered to, or none when the sandbox gets its value.
 */
export type PlannedSecret = {
  label: string
  from: string
  hosts?: readonly string[]
  /** `to: 'checks'`: only `c.exec` and setup steps get it, never the agent. */
  checksOnly?: boolean
  /** `optional: true`: left out of the sandbox when the host variable isn't set. */
  optional?: boolean
}
export type UnbrokeredSecret = Omit<PlannedSecret, 'hosts'>

/**
 * Every secret among `env` and the layers' env and MCP servers (their local plugins' included),
 * layered as the attempt resolves them: a later layer's variable or MCP server replaces an
 * earlier one of the same name.
 */
export function plannedSecrets(env: EnvVars, layers: readonly EnvironmentLayer[]): PlannedSecret[] {
  const vars: EnvVars = { ...env }
  const servers = new Map<string, McpServer>()
  for (const { spec } of layers) {
    Object.assign(vars, spec.env)
    for (const [name, server] of Object.entries(spec.mcp ?? {})) servers.set(name, server)
  }
  for (const [name, server] of localPluginServers(layers)) servers.set(name, server)
  const out = new Map<string, PlannedSecret>()
  const add = (
    label: string,
    from: string,
    hosts: readonly string[] | undefined,
    checksOnly = false,
    optional = false,
  ) =>
    // Keyed by variable too: a header's secret.template can read several.
    out.set(`${label}\0${from}`, {
      label,
      from,
      ...(hosts ? { hosts } : {}),
      ...(checksOnly ? { checksOnly } : {}),
      ...(optional ? { optional } : {}),
    })
  const fromVars = (values: EnvVars, prefix: string) => {
    for (const [name, value] of Object.entries(values)) {
      if (isSecret(value))
        add(
          `${prefix}${name}`,
          value.from ?? name,
          value.hosts,
          value.to === 'checks',
          value.optional === true,
        )
    }
  }
  fromVars(vars, '')
  for (const [server, s] of servers) {
    if (s.transport === 'stdio') {
      fromVars(s.env, `mcp.${server}.env.`)
      continue
    }
    const own = mcpHosts(s.url)
    for (const [header, value] of Object.entries(s.headers)) {
      const label = `mcp.${server}.headers.${header}`
      if (isSecret(value)) add(label, value.from ?? header, value.hosts ?? own)
      if (isSecretTemplate(value)) {
        for (const [, name] of value.template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
          add(label, name as string, own)
        }
      }
    }
  }
  return [...out.values()]
}

/** The secrets the sandbox gets as real values: no `hosts`, and none implied by an MCP URL. */
export const unbrokeredSecrets = (
  env: EnvVars,
  layers: readonly EnvironmentLayer[],
): UnbrokeredSecret[] =>
  plannedSecrets(env, layers).flatMap(({ hosts, ...s }) => (hosts ? [] : [s]))

function secretHelper(): SecretHelper {
  const secret = ((options: SecretOptions = {}) => ({
    kind: 'secret',
    ...secretOptions(options, 'secret()'),
  })) as SecretHelper
  secret.fromEnv = (host, options = {}) => {
    if (typeof host !== 'string' || !VAR.test(host)) {
      throw new DefinitionError(
        `secret.fromEnv(${JSON.stringify(host)}) needs a host variable name: letters, digits and _, not starting with a digit, e.g. secret.fromEnv('API_KEY')`,
      )
    }
    return { kind: 'secret', from: host, ...secretOptions(options, `secret.fromEnv("${host}")`) }
  }
  secret.template = (template) => ({ kind: 'secret-template', template })
  secret.hosts = SECRET_HOSTS
  return secret
}

const MOVING = /^(?:main|master|HEAD|trunk|develop|dev|latest)$/

/** A git ref that isn't a commit SHA or a version-like tag. */
export const isMovingRef = (ref: string | undefined) =>
  ref === undefined ||
  MOVING.test(ref) ||
  !/^(?:[0-9a-f]{7,40}|v?\d+(?:\.\d+)*(?:[-+].*)?)$/.test(ref)

/** `github:owner/repo` and GitHub `/tree/<ref>/<path>` URLs, as a clone URL plus ref and path. */
export function parseGitRepo(repo: string): { url: string; ref?: string; path?: string } {
  const short = /^github:([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repo)
  if (short) return { url: `https://github.com/${short[1]}.git` }
  const tree = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/tree\/([^/]+)(?:\/(.+))?$/.exec(repo)
  if (tree) return { url: `https://github.com/${tree[1]}.git`, ref: tree[2], path: tree[3] }
  return { url: repo }
}

/** `repo#ref:path`, as the plan and the record name a git workspace. */
export const workspaceLabel = (w: Pick<GitWorkspace, 'repo' | 'ref' | 'path'>) =>
  `${w.repo}${w.ref ? `#${w.ref}` : ''}${w.path ? `:${w.path}` : ''}`

/** The workspace an attempt starts as: the last layer that sets one. */
export const workspaceOf = (layers: readonly EnvironmentLayer[]): GitWorkspace | undefined =>
  layers.findLast((l) => l.spec.workspace)?.spec.workspace

/** The paths the layers' `files` write, sorted. */
export const filesOf = (layers: readonly EnvironmentLayer[]): string[] =>
  [...new Set(layers.flatMap((l) => Object.keys(l.spec.files ?? {})))].sort()

/** A URL with its password (or an https username, which is where tokens go) masked. */
function credentialsIn(repo: string): string | undefined {
  if (!URL.canParse(repo)) return undefined
  const u = new URL(repo)
  if (!u.password && !(u.username && /^https?:$/.test(u.protocol))) return undefined
  u.username = u.username && '***'
  u.password = u.password && '***'
  return u.href
}

const GIT_OPTIONS = ['ref', 'path', 'init', 'token']

export const isLocalPath = (repo: string) => /^\.{1,2}(?:\/|$)/.test(repo) || isAbsolute(repo)

function gitHelper(base: string): GitHelper {
  return (repo, options = {}) => {
    const written = repo instanceof URL ? repo.href : repo
    if (typeof written !== 'string' || !written.trim()) {
      throw new DefinitionError(
        `git() needs a repository: a URL, github:owner/repo or a local path (got ${JSON.stringify(repo)})`,
      )
    }
    const what = `git(${JSON.stringify(written)})`
    const masked = credentialsIn(written)
    if (masked) {
      throw new DefinitionError(
        `git(${JSON.stringify(masked)}): the URL has a password or token in it. reeval fetches the repository on the host with your own git credentials (a credential helper, gh auth setup-git or an SSH key), and the sandbox never gets them; remove it from the URL.`,
      )
    }
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new DefinitionError(`${what}: options are { ref?, path? }`)
    }
    const extra = Object.keys(options).filter((k) => !GIT_OPTIONS.includes(k))
    if (extra.length) {
      const hint =
        extra.includes('branch') || extra.includes('tag')
          ? ' Use ref for a branch, tag or commit.'
          : ''
      throw new DefinitionError(
        `${what}: unknown option "${extra.join('", "')}"; it takes ${GIT_OPTIONS.slice(0, -1).join(', ')} and ${GIT_OPTIONS.at(-1)}.${hint}`,
      )
    }
    const local = repo instanceof URL ? repo.protocol === 'file:' : isLocalPath(written)
    const parsed = local ? { url: toPath(repo, base) } : parseGitRepo(written)
    const ref = options.ref ?? parsed.ref
    if (ref !== undefined && (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-'))) {
      throw new DefinitionError(
        `${what}: ref is a branch, tag or commit SHA (got ${JSON.stringify(ref)})`,
      )
    }
    const path = options.path ?? parsed.path
    if (path !== undefined) {
      const clean = typeof path === 'string' ? path.replace(/\/+$/, '') : path
      if (
        typeof clean !== 'string' ||
        !clean ||
        clean.includes('\\') ||
        clean.startsWith('/') ||
        clean.split('/').some((p) => p === '..' || p === '.' || p === '')
      ) {
        throw new DefinitionError(
          `${what}: path is a directory in the repository, relative, with forward slashes and no . or .. (got ${JSON.stringify(path)})`,
        )
      }
    }
    const cleanPath = path?.replace(/\/+$/, '')
    const { init, token } = options
    if (init !== undefined && typeof init !== 'boolean') {
      throw new DefinitionError(`${what}: init is true or false (got ${JSON.stringify(init)})`)
    }
    if (token !== undefined) {
      // Never echo it: a token pasted here instead of its variable's name is the token itself.
      if (
        typeof token !== 'string' ||
        !VAR.test(token) ||
        /^(?:gh[opsur]_|github_pat_)/.test(token)
      ) {
        throw new DefinitionError(
          `${what}: token names the host variable that holds the token, e.g. token: 'GITHUB_TOKEN'. Don't put the token itself in the eval.`,
        )
      }
      if (local || !/^https?:\/\//.test(parsed.url)) {
        throw new DefinitionError(
          `${what}: token only works with an https:// URL; for SSH or a local repository, git uses this machine's own credentials`,
        )
      }
    }
    return {
      kind: 'git',
      // A GitHub /tree/ URL names the repository, ref and path: keep the repository part.
      repo: 'ref' in parsed || 'path' in parsed ? parsed.url.replace(/\.git$/, '') : written,
      url: parsed.url,
      ...(ref ? { ref } : {}),
      ...(cleanPath ? { path: cleanPath } : {}),
      ...(init ? { init } : {}),
      ...(token ? { token } : {}),
    }
  }
}

/**
 * What a skill directory leaves out of the sandbox unless `exclude` says otherwise: eval material
 * (skill-creator keeps `evals/` in the skill), run history and reeval eval files. `.git` is always left out.
 */
export const DEFAULT_SKILL_EXCLUDE: readonly string[] = ['/evals/', '.history/', '*.eval.ts']

function skillHelper(base: string): SkillHelper {
  const placement = (p: string | undefined) => {
    if (p === undefined || p === 'harness' || p === 'workspace') return p ?? 'harness'
    throw new DefinitionError(
      `skill({ placement }) is 'harness' or 'workspace' (got ${JSON.stringify(p)})`,
    )
  }
  const exclude = (e: readonly string[] | undefined) => {
    if (e === undefined) return {}
    if (!Array.isArray(e) || e.some((p) => typeof p !== 'string' || !p.replace(/\//g, ''))) {
      throw new DefinitionError(
        `skill({ exclude }) must be a list of paths or globs, e.g. ['/evals/', '*.eval.ts'] (got ${JSON.stringify(e)})`,
      )
    }
    return { exclude: [...e] }
  }
  return {
    local: (path, o = {}) => ({
      kind: 'skill',
      source: 'local',
      path: toPath(path, base),
      ...(o.only ? { only: [...o.only] } : {}),
      ...exclude(o.exclude),
      placement: placement(o.placement),
    }),
    git: (repo, o = {}) => {
      if (typeof repo !== 'string' || !repo) {
        throw new DefinitionError(
          `skill.git() needs a repository URL, e.g. skill.git('https://github.com/acme/skills') (got ${JSON.stringify(repo)})`,
        )
      }
      const parsed = parseGitRepo(repo)
      const ref = o.ref ?? parsed.ref
      const path = o.path ?? parsed.path
      return {
        kind: 'skill',
        source: 'git',
        repo,
        ...(ref ? { ref } : {}),
        ...(path ? { path } : {}),
        ...(o.only ? { only: [...o.only] } : {}),
        ...exclude(o.exclude),
        placement: placement(o.placement),
      }
    },
    registry: (id, o = {}) => {
      if (!/^[\w.-]+\/[\w.-]+@[a-z0-9-]+$/.test(id)) {
        throw new DefinitionError(
          `skill.registry(${JSON.stringify(id)}) needs an id like owner/repo@skill, e.g. skill.registry('acme/skills@review')`,
        )
      }
      return {
        kind: 'skill',
        source: 'registry',
        id,
        ...(o.version ? { version: o.version } : {}),
        placement: placement(o.placement),
      }
    },
    npm: (spec, o = {}) => ({
      kind: 'skill',
      source: 'npm',
      spec: localNpmSpec(spec, base),
      path: o.path ?? 'skills',
      ...(o.only ? { only: [...o.only] } : {}),
      ...exclude(o.exclude),
      placement: placement(o.placement),
    }),
    inline: (skill, o = {}) => ({
      kind: 'skill',
      source: 'inline',
      name: skill.name,
      description: skill.description,
      content: skill.content,
      files: { ...skill.files },
      placement: placement(o.placement),
    }),
  }
}

function pluginHelper(base: string): PluginHelper {
  const common = (what: string, o: unknown, extra: readonly string[]) => {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      throw new DefinitionError(
        `${what}: options are { ${[...extra, 'only', 'build'].join(', ')} }`,
      )
    }
    const keys = ['only', 'build', ...extra]
    const unknown = Object.keys(o).filter((k) => !keys.includes(k))
    if (unknown.length) {
      const near = closest(unknown[0] as string, keys)
      throw new DefinitionError(
        `${what}: unknown option "${unknown.join('", "')}"; it takes ${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}.${near ? ` Did you mean "${near}"?` : ''}`,
      )
    }
    const { only, build } = o as { only?: unknown; build?: unknown }
    if (
      only !== undefined &&
      (!Array.isArray(only) ||
        only.length === 0 ||
        only.some((p) => !PLUGIN_PARTS.includes(p as PluginPart)))
    ) {
      throw new DefinitionError(
        `${what}: only lists the parts to place, from ${PLUGIN_PARTS.map((p) => `'${p}'`).join(', ')}, e.g. only: ['skills', 'mcp'] (got ${JSON.stringify(only)})`,
      )
    }
    const commands = typeof build === 'string' ? [build] : build
    if (
      build !== undefined &&
      (!Array.isArray(commands) ||
        commands.length === 0 ||
        commands.some((c) => typeof c !== 'string' || !c.trim()))
    ) {
      throw new DefinitionError(
        `${what}: build is a shell command or a list of them (got ${JSON.stringify(build)})`,
      )
    }
    return {
      ...(only ? { only: [...new Set(only as PluginPart[])] } : {}),
      ...(build === undefined
        ? {}
        : { build: typeof build === 'string' ? build : [...(build as string[])] }),
    }
  }
  const dirPath = (what: string, path: unknown, where: string) => {
    if (path === undefined) return undefined
    const clean = typeof path === 'string' ? path.replace(/\/+$/, '') : path
    if (
      typeof clean !== 'string' ||
      !clean ||
      clean.includes('\\') ||
      clean.startsWith('/') ||
      clean.split('/').some((p) => p === '..' || p === '.' || p === '')
    ) {
      throw new DefinitionError(
        `${what}: path is a directory in the ${where}, relative, with forward slashes and no . or .. (got ${JSON.stringify(path)})`,
      )
    }
    return clean
  }
  return {
    local: (path, o = {}) => {
      const written = path instanceof URL ? path.href : path
      if (typeof written !== 'string' || !written) {
        throw new DefinitionError(
          `plugin.local() needs the plugin's directory, relative to this file, e.g. plugin.local('./plugins/review') (got ${JSON.stringify(path)})`,
        )
      }
      const what = `plugin.local(${JSON.stringify(written)})`
      return {
        kind: 'plugin',
        source: 'local',
        path: toPath(path, base),
        ...common(what, o, []),
      }
    },
    git: (repo, o = {}) => {
      if (typeof repo !== 'string' || !repo.trim()) {
        throw new DefinitionError(
          `plugin.git() needs a repository: a URL or github:owner/repo, e.g. plugin.git('github:acme/agent-plugins', { ref: 'v1.2.0' }) (got ${JSON.stringify(repo)})`,
        )
      }
      const what = `plugin.git(${JSON.stringify(repo)})`
      const masked = credentialsIn(repo)
      if (masked) {
        throw new DefinitionError(
          `plugin.git(${JSON.stringify(masked)}): the URL has a password or token in it. reeval fetches the repository on the host with your own git credentials; remove it from the URL.`,
        )
      }
      const options = common(what, o, ['ref', 'path'])
      const parsed = parseGitRepo(repo)
      const ref = (o as { ref?: unknown }).ref ?? parsed.ref
      if (ref !== undefined && (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-'))) {
        throw new DefinitionError(
          `${what}: ref is a branch, tag or commit SHA (got ${JSON.stringify(ref)})`,
        )
      }
      const path = dirPath(what, (o as { path?: unknown }).path ?? parsed.path, 'repository')
      return {
        kind: 'plugin',
        source: 'git',
        repo,
        ...(ref ? { ref: ref as string } : {}),
        ...(path ? { path } : {}),
        ...options,
      }
    },
    npm: (spec, o = {}) => {
      if (typeof spec !== 'string' || !spec.trim()) {
        throw new DefinitionError(
          `plugin.npm() needs a pinned package spec, e.g. plugin.npm('@acme/review-plugin@1.2.0') (got ${JSON.stringify(spec)})`,
        )
      }
      const what = `plugin.npm(${JSON.stringify(spec)})`
      const options = common(what, o, ['path'])
      const path = dirPath(what, (o as { path?: unknown }).path, 'package')
      return {
        kind: 'plugin',
        source: 'npm',
        spec: localNpmSpec(spec, base),
        ...(path ? { path } : {}),
        ...options,
      }
    },
  }
}

/**
 * What `directory()` leaves out unless `defaultIgnores: false`: dependency, build-output, cache
 * and editor directories, in its `glob` syntax. `build/` and `target/` are anchored to the top of
 * the directory, where Flutter, Dart, Gradle and Cargo put their output, since a nested one can be
 * source. `vendor/` isn't here: a committed Go or PHP vendor directory is what an offline build needs.
 */
export const DEFAULT_DIRECTORY_IGNORES: readonly string[] = Object.freeze([
  'node_modules/',
  '.DS_Store',
  'dist/',
  '.next/',
  '.turbo/',
  'coverage/',
  '.cache/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.pytest_cache/',
  '.mypy_cache/',
  '*.pyc',
  '.dart_tool/',
  '/build/',
  '/target/',
  '.gradle/',
  '.idea/',
  '.vscode/',
])

/**
 * A gitignore-style pattern as a test of a file's path, matched by picomatch: a pattern without an
 * inner `/` matches a name at any depth, a leading `/` anchors, a trailing `/` names a directory,
 * and a pattern also matches every file in a directory it names.
 */
function globTest(pattern: string): (path: string, isDir?: boolean) => boolean {
  const dirOnly = pattern.endsWith('/')
  // gitignore negates a set with [!…]; picomatch reads that as a literal !, and negates with [^…].
  const body = pattern.replace(/\/+$/, '').replaceAll('[!', '[^')
  const glob = body.includes('/') ? body.replace(/^\/+/, '') : `**/${body}`
  const self = picomatch(glob, { dot: true })
  const inside = picomatch(`${glob}/**/*`, { dot: true })
  return (path, isDir = false) => inside(path) || ((isDir || !dirOnly) && self(path))
}

/**
 * `glob` as a test of a directory-relative file path: the last pattern that matches decides, a
 * `!` one excluding; a file no pattern matches is in unless some pattern includes.
 */
export function globFilter(
  patterns: readonly string[],
): (path: string, isDir?: boolean) => boolean {
  const rules = patterns.map((p) => ({
    include: !p.startsWith('!'),
    test: globTest(p.replace(/^!/, '')),
  }))
  const start = !rules.some((r) => r.include)
  return (path, isDir) => rules.reduce((keep, r) => (r.test(path, isDir) ? r.include : keep), start)
}

const DIRECTORY_OPTIONS = ['into', 'glob', 'defaultIgnores']

function directoryHelper(base: string): EnvironmentHelpers['directory'] {
  return (path, options = {}) => {
    const written = path instanceof URL ? path.href : path
    const what = `directory(${JSON.stringify(written)})`
    if (typeof written !== 'string' || !written) {
      throw new DefinitionError(
        `directory() needs a path to a directory, relative to this file (got ${JSON.stringify(path)})`,
      )
    }
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new DefinitionError(`${what}: options are { into?, glob?, defaultIgnores? }`)
    }
    const extra = Object.keys(options).filter((k) => !DIRECTORY_OPTIONS.includes(k))
    if (extra.length) {
      const hint =
        extra.includes('ignore') || extra.includes('exclude')
          ? " Exclude with a '!' pattern in glob, e.g. glob: ['!dist/']."
          : ''
      throw new DefinitionError(
        `${what}: unknown option "${extra.join('", "')}"; it takes into, glob and defaultIgnores.${hint}`,
      )
    }
    const { into, glob = [], defaultIgnores = true } = options
    if (
      into !== undefined &&
      (typeof into !== 'string' ||
        into.includes('\\') ||
        isAbsolute(into) ||
        into.split('/').some((p) => p === '..'))
    ) {
      throw new DefinitionError(
        `${what}: into is a directory relative to the workspace (or ~/…), with forward slashes and no .. (got ${JSON.stringify(into)})`,
      )
    }
    if (
      !Array.isArray(glob) ||
      glob.some((p) => typeof p !== 'string' || !p.replace(/^!/, '').replace(/\//g, ''))
    ) {
      throw new DefinitionError(
        `${what}: glob is a list of patterns, e.g. ['src/**', 'package.json', '!**/*.test.ts'] (got ${JSON.stringify(glob)})`,
      )
    }
    if (typeof defaultIgnores !== 'boolean') {
      throw new DefinitionError(
        `${what}: defaultIgnores is true or false (got ${JSON.stringify(defaultIgnores)})`,
      )
    }
    const root = toPath(path, base)
    const stat = statSync(root, { throwIfNoEntry: false })
    if (!stat) throw new DefinitionError(`${what}: ${root} doesn't exist`)
    if (!stat.isDirectory()) {
      throw new DefinitionError(
        `${what}: ${root} is a file, not a directory. Use file(${JSON.stringify(written)}) for one file.`,
      )
    }
    const skip = defaultIgnores ? globFilter(DEFAULT_DIRECTORY_IGNORES) : () => false
    const keep = globFilter(glob)
    const prefix = into?.replace(/\/+$/, '').replace(/^\.\/?/, '')
    const files: Record<string, HostFile> = {}
    const walk = (dir: string, rel: string, seen: readonly string[]) => {
      for (const name of readdirSync(dir).sort()) {
        if (name === '.git') continue
        const full = join(dir, name)
        const relPath = rel ? `${rel}/${name}` : name
        const target = statSync(full, { throwIfNoEntry: false })
        if (!target) {
          throw new DefinitionError(
            `${what}: ${relPath} is a symlink to something that doesn't exist. Remove it, or leave it out with glob: ['!${relPath}'].`,
          )
        }
        if (target.isDirectory()) {
          if (skip(relPath, true)) continue
          const real = realpathSync(full)
          if (seen.includes(real)) {
            throw new DefinitionError(
              `${what}: ${relPath} is a symlink to a directory that contains it. Leave it out with glob: ['!${relPath}/'].`,
            )
          }
          walk(full, relPath, [...seen, real])
        } else if (target.isFile() && !skip(relPath) && keep(relPath)) {
          files[prefix ? `${prefix}/${relPath}` : relPath] = { kind: 'file', path: full }
        }
      }
    }
    walk(root, '', [realpathSync(root)])
    if (Object.keys(files).length === 0) {
      throw new DefinitionError(
        `${what}: no files in ${root}${glob.length || defaultIgnores ? ` match (glob ${JSON.stringify(glob)}${defaultIgnores ? ', after the default ignores such as node_modules/ and dist/; defaultIgnores: false keeps them' : ''})` : ''}. Empty directories aren't seeded; create one with a setup step.`,
      )
    }
    return files
  }
}

const mcpHelper: McpHelper = {
  stdio: (command, args = [], o = {}) => {
    if (typeof command !== 'string' || !command) {
      throw new DefinitionError(
        `mcp.stdio() needs a command, e.g. mcp.stdio('npx', ['-y', 'server']) (got ${JSON.stringify(command)})`,
      )
    }
    return { kind: 'mcp', transport: 'stdio', command, args: [...args], env: { ...o.env } }
  },
  http: (url, o = {}) => ({ kind: 'mcp', transport: 'http', url, headers: { ...o.headers } }),
  sse: (url, o = {}) => ({ kind: 'mcp', transport: 'sse', url, headers: { ...o.headers } }),
}

/** The helpers a callback gets, with relative paths resolving against `base`. */
export function helpersFor(base: string): EnvironmentHelpers {
  return {
    secret: secretHelper(),
    skill: skillHelper(base),
    mcp: mcpHelper,
    plugin: pluginHelper(base),
    file: (path) => ({ kind: 'file', path: toPath(path, base) }),
    directory: directoryHelper(base),
    git: gitHelper(base),
  }
}

/** Throws on env variables that aren't strings or secrets, or look like literal secrets. */
export function checkEnv(env: unknown, where: string, Err = DefinitionError): void {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new Err(
      `env in ${where} must be an object of variables, e.g. env: { NODE_ENV: 'test' } (got ${JSON.stringify(env)})`,
    )
  }
  for (const [name, value] of Object.entries(env)) {
    if (!VAR.test(name))
      throw new Err(
        `env.${name} in ${where} isn't a valid variable name: use letters, digits and _, not starting with a digit`,
      )
    if (isSecret(value)) {
      const problem = descriptorProblem(secretSchema, value, 'secret')
      if (problem) throw new Err(`env.${name} in ${where}: ${problem}`)
      continue
    }
    if (typeof value !== 'string') {
      throw new Err(
        `env.${name} in ${where} must be a string or secret.fromEnv() (got ${JSON.stringify(value)})`,
      )
    }
    if (SECRET_NAME.test(name)) {
      throw new Err(
        `env.${name} in ${where} is a literal string. Pass secrets with secret.fromEnv() so they're redacted and never recorded.`,
      )
    }
  }
}

export const stepCommand = (step: string | { run: string }) =>
  typeof step === 'string' ? step : step.run

function checkSpec(spec: unknown, where: string): EnvironmentSpec {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new DefinitionError(
      `${where} must be an object or a callback that returns one (got ${JSON.stringify(spec)})`,
    )
  }
  for (const key of Object.keys(spec)) {
    if (SPEC_KEYS.includes(key)) continue
    if (SANDBOX_KEYS.includes(key)) {
      // `image: 'node:22'` names a base image; `image: ['npm i -g x']` lists install steps.
      const value = (spec as Record<string, unknown>)[key]
      const as = key === 'image' ? (typeof value === 'string' ? 'from' : 'install') : key
      throw new DefinitionError(
        `"${key}" isn't an environment field (${where}). Put the image on the sandbox: sandbox: docker({ ${as}: … }).`,
      )
    }
    const near = SPEC_HINTS[key] ?? closest(key, SPEC_KEYS)
    const hint = near ? ` Did you mean "${near}"?` : ''
    throw new DefinitionError(`Unknown field "${key}" in ${where}.${hint}`)
  }
  const s = spec as EnvironmentSpec
  if (s.sandbox !== undefined) checkSandbox(s.sandbox, where)
  if (s.workspace !== undefined && (s.workspace as GitWorkspace | null)?.kind !== 'git') {
    throw new DefinitionError(
      `workspace in ${where} must come from the git helper, e.g. workspace: git('https://github.com/acme/app', { ref: 'v1.0.0' }) (got ${JSON.stringify(s.workspace)})`,
    )
  }
  if (s.workspace !== undefined) {
    const problem = descriptorProblem(gitWorkspaceSchema, s.workspace, 'git')
    if (problem) throw new DefinitionError(`workspace in ${where}: ${problem}`)
  }
  if (s.env !== undefined) checkEnv(s.env, where)
  if (s.egress !== undefined) checkEgress(s.egress, where)
  const list = <T>(key: 'setup' | 'skills' | 'plugins', value: T[] | undefined): T[] => {
    if (value !== undefined && !Array.isArray(value)) {
      throw new DefinitionError(`${key} in ${where} must be a list (got ${JSON.stringify(value)})`)
    }
    return value ?? []
  }
  for (const [i, step] of list('setup', s.setup).entries()) {
    const run = typeof step === 'string' ? step : isObjectLike(step) ? step.run : undefined
    if (typeof run !== 'string' || !run.trim()) {
      throw new DefinitionError(
        `setup[${i}] in ${where} must be a command string or { run, timeout?, cwd? } (got ${JSON.stringify(step)})`,
      )
    }
    if (typeof step === 'string') continue
    const extra = Object.keys(step).filter((k) => !['run', 'timeout', 'cwd'].includes(k))
    if (extra.length) {
      throw new DefinitionError(
        `setup step "${run}" in ${where} has an unknown key "${extra[0]}"; a step is a string or { run, timeout?, cwd? }.`,
      )
    }
    const { cwd, timeout } = step
    if (timeout !== undefined) {
      try {
        parseDuration(timeout)
      } catch (error) {
        throw new DefinitionError(`setup step "${run}" in ${where}: ${(error as Error).message}`)
      }
    }
    if (cwd !== undefined && (typeof cwd !== 'string' || !cwd.trim())) {
      throw new DefinitionError(
        `setup step "${run}" in ${where}: cwd must be a directory path, relative to the workspace or absolute (got ${JSON.stringify(cwd)})`,
      )
    }
  }
  for (const [i, skill] of list('skills', s.skills).entries()) {
    if (skill?.kind !== 'skill') {
      throw new DefinitionError(
        `skills in ${where} must come from the skill helper, e.g. skills: [skill.local('./skills')] (got ${JSON.stringify(skill)})`,
      )
    }
    const call = `skill.${String(skill.source)}`
    const problem = descriptorProblem(skillSourceSchema, skill, call)
    if (problem) throw new DefinitionError(`skills[${i}] in ${where}: ${problem}`)
  }
  for (const [i, plugin] of list('plugins', s.plugins).entries()) {
    if (plugin?.kind !== 'plugin') {
      throw new DefinitionError(
        `plugins in ${where} must come from the plugin helper, e.g. plugins: [plugin.local('./plugins/review')] (got ${JSON.stringify(plugin)})`,
      )
    }
    const call = `plugin.${String(plugin.source)}`
    const problem = descriptorProblem(pluginSourceSchema, plugin, call)
    if (problem) throw new DefinitionError(`plugins[${i}] in ${where}: ${problem}`)
  }
  for (const [name, server] of Object.entries(s.mcp ?? {})) {
    if (server?.kind !== 'mcp') {
      throw new DefinitionError(
        `mcp.${name} in ${where} must come from the mcp helper, e.g. mcp.stdio('npx', ['-y', 'server']) (got ${JSON.stringify(server)})`,
      )
    }
    const call = `mcp.${String(server.transport)}`
    const problem = descriptorProblem(mcpServerSchema, server, call)
    if (problem) throw new DefinitionError(`mcp.${name} in ${where}: ${problem}`)
  }
  for (const [path, value] of Object.entries(s.files ?? {})) {
    const key = `files[${JSON.stringify(path)}] in ${where}`
    if (path.includes('\\')) {
      throw new DefinitionError(`${key}: use forward slashes (${path.replaceAll('\\', '/')})`)
    }
    const rest = path.startsWith('~/') ? path.slice(2) : path
    // On the fake sandbox a file is written on the host, so it must stay in the sandbox's dirs.
    if (!rest || isAbsolute(rest) || rest.split('/').includes('..')) {
      throw new DefinitionError(
        `${key}: paths are relative to the workspace, or start with ~/ for the home directory, and never use ..`,
      )
    }
    if (typeof value !== 'string' && !isHostFile(value)) {
      throw new DefinitionError(
        `${key} must be a string or file(path) (got ${JSON.stringify(value)})`,
      )
    }
    const problem = isHostFile(value) && descriptorProblem(hostFileSchema, value, 'file')
    if (problem) throw new DefinitionError(`${key}: ${problem}`)
  }
  if (s.rules !== undefined && typeof s.rules !== 'string' && !isHostFile(s.rules)) {
    throw new DefinitionError(
      `rules in ${where} must be markdown or file(path) (got ${JSON.stringify(s.rules)})`,
    )
  }
  const rules = isHostFile(s.rules) && descriptorProblem(hostFileSchema, s.rules, 'file')
  if (rules) throw new DefinitionError(`rules in ${where}: ${rules}`)
  const rest = refusal(
    environmentSpecSchema,
    s,
    (issue, value) => `${where}: ${genericProblem('', issue, value)}`,
  )
  if (rest) throw new DefinitionError(rest)
  return structuredClone(s)
}

const NAME_RULE = 'a name of letters, digits, ".", "_", "@", "+" or "-"'

/** The envelope of environment data: its name and layers, each layer's spec only as an object. */
const environmentEnvelope = environmentDataSchema.extend({
  layers: z.array(
    z.strictObject({ name: z.string().regex(NAME), spec: z.record(z.string(), z.unknown()) }),
  ),
})

/**
 * What's wrong with an environment as data (from another language, or built by hand), in the
 * words `defineEnvironment` uses for each layer's spec, or undefined. `option` names the option
 * (`environment`, `compare.baseline`, …) and `where` the eval or config that set it.
 */
export function environmentDataProblem(
  value: unknown,
  option: string,
  at: string,
): string | undefined {
  const env = value as EnvironmentData
  const where = `${option} in ${at}`
  const envelope = refusal(environmentEnvelope, value, (issue: Issue) => {
    const [key, index, field] = issue.path as [string?, number?, string?]
    const layer = index === undefined ? undefined : env.layers[index]
    if (issue.code === 'unrecognized_keys') {
      const what = layer ? `layer ${index} of the environment` : 'the environment'
      return `${where}: ${what} has no "${issue.keys[0]}" field`
    }
    if (key === 'name') return `${where} needs ${NAME_RULE} (got ${got(env.name)})`
    if (field === 'name') {
      return `${where}: layer ${index} of "${env.name}" needs ${NAME_RULE} (got ${got(layer?.name)})`
    }
    if (field === 'spec') {
      return `${where}: layer "${layer?.name}" of "${env.name}" needs its spec, an object (got ${got(layer?.spec)})`
    }
    return `${where}: ${genericProblem('environment', issue, value)}`
  })
  if (envelope) return envelope
  for (const layer of env.layers) {
    try {
      const of = option === 'environment' ? at : where
      checkSpec(layer.spec, `layer "${layer.name}" of environment "${env.name}" in ${of}`)
    } catch (error) {
      if (error instanceof DefinitionError) return error.message
      throw error
    }
  }
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPath = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** Throws for a Dockerfile, at `field` (e.g. `sandbox.dockerfile`), that isn't a file at `full`. */
export type MissingDockerfile = (field: string, full: string) => never

/**
 * A sandbox descriptor written as data with its host paths made absolute against `base`, as
 * `docker({ dockerfile })` and `fakeSandbox({ dir })` resolve theirs: a Dockerfile, which must be
 * a file, and a fake sandbox's `dir`. Any other value is left for the checks to name.
 */
export function sandboxPaths(
  value: unknown,
  base: string,
  field: string,
  missing: MissingDockerfile,
): unknown {
  if (!isRecord(value)) return value
  if (value.kind === 'docker' && isPath(value.dockerfile)) {
    const full = toPath(value.dockerfile, base)
    if (!statSync(full, { throwIfNoEntry: false })?.isFile()) missing(`${field}.dockerfile`, full)
    return { ...value, dockerfile: full }
  }
  return value.kind === 'fake' && isPath(value.dir)
    ? { ...value, dir: toPath(value.dir, base) }
    : value
}

/**
 * An environment spec written as data with its host paths made absolute against `base`, as the
 * helpers resolve theirs: host files in `files` and `rules`, a local skill's or plugin's `path`, a
 * local npm skill or plugin spec, a local git workspace's `url`, and the sandbox's. Only a
 * non-empty string changes, and an absolute path stays as written.
 */
export function specPaths(
  value: unknown,
  base: string,
  field: string,
  missing: MissingDockerfile,
): unknown {
  if (!isRecord(value)) return value
  const hostFile = (v: unknown) =>
    isRecord(v) && v.kind === 'file' && isPath(v.path) ? { ...v, path: toPath(v.path, base) } : v
  const skill = (v: unknown) => {
    if (!isRecord(v)) return v
    if (v.source === 'local' && isPath(v.path)) return { ...v, path: toPath(v.path, base) }
    return v.source === 'npm' && isPath(v.spec) ? { ...v, spec: localNpmSpec(v.spec, base) } : v
  }
  const out = { ...value }
  const prefix = field ? `${field}.` : ''
  if ('sandbox' in value)
    out.sandbox = sandboxPaths(value.sandbox, base, `${prefix}sandbox`, missing)
  const { workspace, files, rules, skills, plugins } = value
  if (isRecord(workspace) && isPath(workspace.url) && isLocalPath(workspace.url)) {
    out.workspace = { ...workspace, url: toPath(workspace.url, base) }
  }
  if (isRecord(files)) {
    out.files = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, hostFile(v)]))
  }
  if ('rules' in value) out.rules = hostFile(rules)
  if (Array.isArray(skills)) out.skills = skills.map(skill)
  if (Array.isArray(plugins)) out.plugins = plugins.map(skill)
  return out
}

/**
 * An environment written as data with each layer's spec given absolute host paths against `base`,
 * as `specPaths` gives one spec. Anything that isn't environment data is left for the checks.
 */
export function environmentPaths(
  value: unknown,
  base: string,
  field: string,
  missing: MissingDockerfile,
): unknown {
  if (!isRecord(value) || !Array.isArray(value.layers)) return value
  return {
    ...value,
    layers: value.layers.map((layer, i) =>
      isRecord(layer)
        ? { ...layer, spec: specPaths(layer.spec, base, `${field}.layers[${i}].spec`, missing) }
        : layer,
    ),
  }
}

function buildSpec(input: EnvironmentInput, where: string, base: string): EnvironmentSpec {
  const spec = typeof input === 'function' ? input(helpersFor(base)) : input
  if (spec instanceof Promise || typeof (spec as { then?: unknown })?.then === 'function') {
    throw new DefinitionError(
      `${where} returned a Promise. The callback runs once at definition time and must return the environment synchronously; fetch remote content in a setup step instead.`,
    )
  }
  const missing: MissingDockerfile = (field, full) => {
    throw new DefinitionError(
      `${field} in ${where}: ${full} doesn't exist. Paths are relative to the file that defines the environment.`,
    )
  }
  return checkSpec(specPaths(spec, base, '', missing) as EnvironmentSpec, where)
}

/** An environment from its data, as a declaration tree carries it: `extendEnvironment` works again. */
export const environmentFrom = (data: EnvironmentData): Environment =>
  makeEnvironment(data.name, [...data.layers])

function makeEnvironment(name: string, layers: EnvironmentLayer[]): Environment {
  const env = { kind: 'environment' as const, name, layers: Object.freeze(layers) }
  const extend = (child: string, input: EnvironmentInput) => {
    checkName(child, `${name}.extend`)
    const where = `${name}.extend("${child}")`
    const base = callerDir() ?? process.cwd()
    return makeEnvironment(child, [...layers, { name: child, spec: buildSpec(input, where, base) }])
  }
  Object.defineProperty(env, 'extendEnvironment', { enumerable: false, value: extend })
  Object.defineProperty(env, 'extend', { enumerable: false, value: extend })
  return Object.freeze(env) as Environment
}

function checkName(name: unknown, what: string): asserts name is string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new DefinitionError(
      `${what} needs a name of letters, digits, ".", "_", "@", "+" or "-" (got ${JSON.stringify(name)})`,
    )
  }
}

/**
 * What an eval runs in: the sandbox, skills, MCP servers, files, rules, variables, secrets and
 * setup steps. Pass a spec, or a callback that destructures the typed helpers it needs:
 *
 *     defineEnvironment('genkit', ({ secret, skill }) => ({
 *       sandbox: docker({ from: 'node:24-bookworm' }),
 *       env: { GOOGLE_GENAI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY') },
 *       skills: [skill.local('../skills/genkit')],
 *     }))
 *
 * The callback runs once, synchronously. Relative paths resolve against the calling file.
 * `extend` / `extendEnvironment` replace `sandbox` entirely when the child sets one; when
 * the child omits it, the parent's sandbox is kept. A bare `defineEnvironment('plain', {})`
 * that is not an extend uses the cascaded option sandbox, else implicit Docker.
 */
export function defineEnvironment(name: string, input: EnvironmentInput): Environment {
  checkName(name, 'defineEnvironment')
  const base = callerDir() ?? process.cwd()
  return makeEnvironment(name, [
    { name, spec: buildSpec(input, `defineEnvironment("${name}")`, base) },
  ])
}

/** What an attempt runs in: one environment's own layers. */
export type AppliedEnvironment = {
  name: string
  parent: string | null
  layers: EnvironmentLayer[]
}

export const NO_ENVIRONMENT = '-'

/** The control of a compare without a `baseline` when nothing in the cascade sets an environment. */
export const EMPTY_BASELINE = 'baseline'

/**
 * An environment with no layers. As a compare's empty control it uses the first
 * variant's sandbox when that variant sets one, else the cascaded option sandbox,
 * else the implicit default Docker sandbox.
 */
export const emptyEnvironment = (name: string): Environment => makeEnvironment(name, [])

/** The last layer that sets `sandbox`, else `fallback` (the cascaded option sandbox). */
export const sandboxOf = (
  layers: readonly EnvironmentLayer[],
  fallback: SandboxDescriptor,
): SandboxDescriptor => layers.findLast((l) => l.spec.sandbox)?.spec.sandbox ?? fallback

/** The sandbox an environment names, else `fallback`. */
export const environmentSandbox = (
  env: Pick<Environment, 'layers'> | undefined,
  fallback: SandboxDescriptor,
): SandboxDescriptor => sandboxOf(env?.layers ?? [], fallback)

function checkSandbox(value: unknown, where: string): asserts value is SandboxDescriptor {
  const kind = isObjectLike(value) ? value.kind : undefined
  if (!isObjectLike(value) || (kind !== 'docker' && kind !== 'fake')) {
    throw new DefinitionError(
      `sandbox in ${where} must come from docker(), podman() or fakeSandbox() (got ${JSON.stringify(value)})`,
    )
  }
  const max = value.maxConcurrent
  if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max >= 1)) {
    throw new DefinitionError(
      `sandbox.maxConcurrent in ${where} must be a whole number of at least 1 (got ${String(max)})`,
    )
  }
  const problem = sandboxProblem(value as SandboxDescriptor)
  if (problem) throw new DefinitionError(`sandbox in ${where}: ${problem}`)
}

export function applied(env: Pick<Environment, 'name' | 'layers'> | undefined): AppliedEnvironment {
  if (!env) return { name: NO_ENVIRONMENT, parent: null, layers: [] }
  return {
    name: env.name,
    parent: env.layers.at(-2)?.name ?? null,
    layers: [...env.layers],
  }
}
