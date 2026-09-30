import { readdirSync, realpathSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDuration } from './duration.ts'
import { SECRET_NAME } from './redact.ts'
import { COMPILED, PACKAGE_DIR } from './root.ts'
import type {
  Duration,
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
  Secret,
  SecretHelper,
  SecretOptions,
  SecretTemplate,
  SkillHelper,
  SkillSource,
  SubstituteIn,
} from './types.ts'

export class DefinitionError extends Error {
  override name = 'DefinitionError'
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/
const SPEC_KEYS = ['workspace', 'env', 'egress', 'files', 'rules', 'setup', 'skills', 'mcp']
/** Image fields that belong on the sandbox, not the environment. */
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
  file: 'files',
  agents: 'rules',
  use: 'extend',
  repo: 'workspace',
  git: 'workspace',
  template: 'workspace',
}

export const isSecret = (value: unknown): value is Secret =>
  typeof value === 'object' && value !== null && (value as Secret).kind === 'secret'

export const isSecretTemplate = (value: unknown): value is SecretTemplate =>
  typeof value === 'object' &&
  value !== null &&
  (value as SecretTemplate).kind === 'secret-template'

export const isHostFile = (value: unknown): value is HostFile =>
  typeof value === 'object' && value !== null && (value as HostFile).kind === 'file'

export const isEnvironment = (value: unknown): value is Environment =>
  typeof value === 'object' &&
  value !== null &&
  (value as Environment).kind === 'environment' &&
  Array.isArray((value as Environment).layers)

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

const toPath = (value: string | URL, base: string) => {
  const path = value instanceof URL ? fileURLToPath(value) : value
  return isAbsolute(path) ? path : resolve(base, path)
}

/**
 * A tarball or folder spec (`./x.tgz`, `../pkg`, `/abs`, `file:…`) as an absolute path, resolved
 * like `file()`; npm resolves relative ones against its working directory, reeval's cache.
 */
const localNpmSpec = (spec: string, base: string) => {
  const path = spec.startsWith('file:') ? spec.slice('file:'.length) : spec
  return /^\.{1,2}(?:\/|$)/.test(path) || isAbsolute(path) ? toPath(path, base) : spec
}

/** A host name, or `*.` and a domain for its subdomains. */
const HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i
const SUBSTITUTE_IN: readonly SubstituteIn[] = ['header', 'query', 'body']

/** Why `host` isn't a host name or `*.` pattern, or undefined when it is one. */
function badHost(host: unknown): string | undefined {
  if (typeof host === 'string' && HOST.test(host)) {
    const name = host.replace(/^\*\./, '')
    if (/(?:^|\.)\d+$/.test(name) && (name !== host || isIP(name) !== 4)) {
      return `'${host}' isn't a host name or an IPv4 address, and a *. pattern never matches an address.`
    }
    if (name !== host && !name.includes('.')) {
      return `'${host}' would allow every host under .${name}; name the domain, e.g. '*.example.${name}'.`
    }
    return undefined
  }
  if (typeof host === 'string' && /^[a-z]+:\/\//i.test(host)) {
    return `hosts are host names, not URLs: use '${new URL(host).hostname}' (got '${host}')`
  }
  if (typeof host === 'string' && /^[^:/]+:\d+$/.test(host)) {
    return `hosts are host names without a port: use '${host.split(':')[0]}' (got '${host}')`
  }
  return `${JSON.stringify(host)} isn't a host. Use a name like 'api.example.com', or '*.example.com' for its subdomains.`
}

/** Throws unless `value` is `'allow-all'`, `'deny-all'` or `{ allow: [hosts] }`. */
export function checkEgress(
  value: unknown,
  where: string,
  Err: new (message: string) => Error = DefinitionError,
): asserts value is EgressPolicy {
  if (value === 'allow-all' || value === 'deny-all') return
  const shape = `egress is 'allow-all' (the default), 'deny-all', or { allow: ['api.example.com', '*.example.org'] }`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const list = Array.isArray(value)
      ? ` For a list of hosts, use { allow: ${JSON.stringify(value)} }.`
      : ''
    throw new Err(`${shape} (got ${JSON.stringify(value)}) in ${where}.${list}`)
  }
  for (const key of Object.keys(value)) {
    if (key === 'allow') continue
    const hint =
      key === 'deny'
        ? " A policy lists what's allowed; everything else is refused."
        : key === 'hosts' || key === 'allowedHosts'
          ? ' Did you mean "allow"?'
          : ''
    throw new Err(`Unknown egress key "${key}" in ${where}.${hint}`)
  }
  const allow = (value as { allow?: unknown }).allow
  if (!Array.isArray(allow)) {
    throw new Err(`${shape} (got ${JSON.stringify(value)}) in ${where}`)
  }
  for (const host of allow) {
    const bad = badHost(host)
    if (bad) throw new Err(`egress.allow in ${where}: ${bad}`)
  }
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
    throw new DefinitionError(`${what}: to must be 'agent' or 'checks'`)
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
 * Every secret among `env` and the layers' env and MCP servers, layered as the attempt resolves
 * them: a later layer's variable or MCP server replaces an earlier one of the same name.
 */
export function plannedSecrets(env: EnvVars, layers: readonly EnvironmentLayer[]): PlannedSecret[] {
  const vars: EnvVars = { ...env }
  const servers = new Map<string, McpServer>()
  for (const { spec } of layers) {
    Object.assign(vars, spec.env)
    for (const [name, server] of Object.entries(spec.mcp ?? {})) servers.set(name, server)
  }
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
        `secret.fromEnv(${JSON.stringify(host)}) needs a host variable name`,
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

const isLocalPath = (repo: string) => /^\.{1,2}(?:\/|$)/.test(repo) || isAbsolute(repo)

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
    throw new DefinitionError(`skill placement must be 'harness' or 'workspace' (got ${p})`)
  }
  const exclude = (e: readonly string[] | undefined) => {
    if (e === undefined) return {}
    if (!Array.isArray(e) || e.some((p) => typeof p !== 'string' || !p.replace(/\//g, ''))) {
      throw new DefinitionError(
        `skill exclude must be an array of paths or globs, e.g. ['/evals/', '*.eval.ts'] (got ${JSON.stringify(e)})`,
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
        throw new DefinitionError('skill.git() needs a repository URL')
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
        throw new DefinitionError(`skill.registry("${id}") needs an id like owner/repo@skill`)
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

/** A gitignore-style pattern as a test of a file's path, which also matches a file in a directory it names. */
function globTest(pattern: string): (path: string) => boolean {
  const dirOnly = pattern.endsWith('/')
  const body = pattern.replace(/\/+$/, '')
  const anchored = body.includes('/')
  let re = ''
  const glob = body.replace(/^\/+/, '')
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[' && glob.indexOf(']', i + 2) > i) {
      const end = glob.indexOf(']', i + 2)
      const set = glob.slice(i + 1, end).replace(/\\/g, '\\\\')
      re += `[${set.startsWith('!') ? `^${set.slice(1)}` : set}]`
      i = end
    } else re += c.replace(/[.+^${}()|[\]\\/]/g, '\\$&')
  }
  const regex = new RegExp(`${anchored ? '^' : '(?:^|/)'}${re}${dirOnly ? '/' : '(?:$|/)'}`)
  return (path) => regex.test(path)
}

/**
 * `glob` as a test of a directory-relative file path: the last pattern that matches decides, a
 * `!` one excluding; a file no pattern matches is in unless some pattern includes.
 */
export function globFilter(patterns: readonly string[]): (path: string) => boolean {
  const rules = patterns.map((p) => ({
    include: !p.startsWith('!'),
    test: globTest(p.replace(/^!/, '')),
  }))
  const start = !rules.some((r) => r.include)
  return (path) => rules.reduce((keep, r) => (r.test(path) ? r.include : keep), start)
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
          if (skip(`${relPath}/`)) continue
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
        `${what}: no files in ${root}${glob.length || defaultIgnores ? ` match (glob ${JSON.stringify(glob)}${defaultIgnores ? ', after DEFAULT_DIRECTORY_IGNORES' : ''})` : ''}. Empty directories aren't seeded; create one with a setup step.`,
      )
    }
    return files
  }
}

const mcpHelper: McpHelper = {
  stdio: (command, args = [], o = {}) => {
    if (typeof command !== 'string' || !command) {
      throw new DefinitionError('mcp.stdio() needs a command')
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
    file: (path) => ({ kind: 'file', path: toPath(path, base) }),
    directory: directoryHelper(base),
    git: gitHelper(base),
  }
}

/** Throws on env variables that aren't strings or secrets, or look like literal secrets. */
export function checkEnv(env: unknown, where: string, Err = DefinitionError): void {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new Err(`env must be an object of variables in ${where}`)
  }
  for (const [name, value] of Object.entries(env)) {
    if (!VAR.test(name)) throw new Err(`env.${name} in ${where} isn't a valid variable name`)
    if (isSecret(value)) continue
    if (typeof value !== 'string') {
      throw new Err(`env.${name} in ${where} must be a string or secret.fromEnv()`)
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
    throw new DefinitionError(`${where} must be an object or a callback that returns one`)
  }
  for (const key of Object.keys(spec)) {
    if (SPEC_KEYS.includes(key)) continue
    if (SANDBOX_KEYS.includes(key)) {
      // `image: 'node:22'` names a base image; `image: ['npm i -g x']` lists install steps.
      const value = (spec as Record<string, unknown>)[key]
      const as = key === 'image' ? (typeof value === 'string' ? 'from' : 'install') : key
      throw new DefinitionError(
        `"${key}" isn't an environment field (${where}). What's baked into the image is the sandbox's: docker({ ${as}: … }). An environment only runs setup steps, in every attempt, with its secrets.`,
      )
    }
    const hint = SPEC_HINTS[key] ? ` Did you mean "${SPEC_HINTS[key]}"?` : ''
    throw new DefinitionError(`Unknown field "${key}" in ${where}.${hint}`)
  }
  const s = spec as EnvironmentSpec
  if (s.workspace !== undefined && (s.workspace as GitWorkspace | null)?.kind !== 'git') {
    throw new DefinitionError(
      `workspace in ${where} must come from the git helper, e.g. workspace: git('https://github.com/acme/app', { ref: 'v1.0.0' }) (got ${JSON.stringify(s.workspace)})`,
    )
  }
  if (s.env !== undefined) checkEnv(s.env, where)
  if (s.egress !== undefined) checkEgress(s.egress, where)
  const list = (key: 'setup' | 'skills') => {
    const value = s[key]
    if (value !== undefined && !Array.isArray(value)) {
      throw new DefinitionError(`${key} in ${where} must be a list`)
    }
    return value ?? []
  }
  for (const step of list('setup')) {
    const shape = `Steps in ${where} are strings or { run, timeout?, cwd? } objects`
    const run = typeof step === 'string' ? step : (step as { run?: unknown })?.run
    if (typeof run !== 'string' || !run.trim()) throw new DefinitionError(shape)
    if (typeof step === 'string') continue
    const extra = Object.keys(step).filter((k) => !['run', 'timeout', 'cwd'].includes(k))
    if (extra.length) throw new DefinitionError(`${shape} (got "${extra.join('", "')}")`)
    const { cwd, timeout } = step as { cwd?: unknown; timeout?: Duration }
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
  for (const skill of list('skills')) {
    if ((skill as SkillSource)?.kind !== 'skill') {
      throw new DefinitionError(
        `skills in ${where} must come from the skill helper, e.g. skills: [skill.local('./skills')] (got ${JSON.stringify(skill)})`,
      )
    }
  }
  for (const [name, server] of Object.entries(s.mcp ?? {})) {
    if ((server as McpServer)?.kind !== 'mcp') {
      throw new DefinitionError(
        `mcp.${name} in ${where} must come from the mcp helper, e.g. mcp.stdio('npx', ['-y', 'server'])`,
      )
    }
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
      throw new DefinitionError(`${key} must be a string or file(path)`)
    }
  }
  if (s.rules !== undefined && typeof s.rules !== 'string' && !isHostFile(s.rules)) {
    throw new DefinitionError(`rules in ${where} must be markdown or file(path)`)
  }
  return structuredClone(s)
}

function buildSpec(input: EnvironmentInput, where: string, base: string): EnvironmentSpec {
  const spec = typeof input === 'function' ? input(helpersFor(base)) : input
  if (spec instanceof Promise || typeof (spec as { then?: unknown })?.then === 'function') {
    throw new DefinitionError(
      `${where} returned a Promise. The callback runs once at definition time and must return the environment synchronously; fetch remote content in a setup step instead.`,
    )
  }
  return checkSpec(spec, where)
}

/** An environment from its data, as a declaration tree carries it: `extendEnvironment` works again. */
export const environmentFrom = (data: EnvironmentData): Environment =>
  makeEnvironment(data.name, [...data.layers])

function makeEnvironment(name: string, layers: EnvironmentLayer[]): Environment {
  const env = { kind: 'environment' as const, name, layers: Object.freeze(layers) }
  Object.defineProperty(env, 'extendEnvironment', {
    enumerable: false,
    value(child: string, input: EnvironmentInput) {
      checkName(child, `${name}.extendEnvironment`)
      const where = `${name}.extendEnvironment("${child}")`
      const base = callerDir() ?? process.cwd()
      return makeEnvironment(child, [
        ...layers,
        { name: child, spec: buildSpec(input, where, base) },
      ])
    },
  })
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
 * What an eval runs in: skills, MCP servers, files, rules, variables, secrets and setup steps.
 * Pass a spec, or a callback that destructures the typed helpers it needs:
 *
 *     defineEnvironment('genkit', ({ secret, skill }) => ({
 *       env: { GOOGLE_GENAI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY') },
 *       skills: [skill.local('../skills/genkit')],
 *     }))
 *
 * The callback runs once, synchronously. Relative paths resolve against the calling file.
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

export function applied(env: Pick<Environment, 'name' | 'layers'> | undefined): AppliedEnvironment {
  if (!env) return { name: NO_ENVIRONMENT, parent: null, layers: [] }
  return {
    name: env.name,
    parent: env.layers.at(-2)?.name ?? null,
    layers: [...env.layers],
  }
}
