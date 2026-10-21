// Worker side of environments: layers an attempt's environments, reads skills, plugins and files
// on the host, resolves secrets, and computes the digest that goes into fingerprints. Nothing here
// touches the sandbox.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { hostAllowed, placeholder, type Substitution } from '@reeval/sandbox-docker'
import { run } from '@reeval/sandbox-docker/process'
import { parse as parseYaml } from 'yaml'
import { badCharacterAt, parseDuration } from '../config.ts'
import {
  type AppliedEnvironment,
  DEFAULT_SKILL_EXCLUDE,
  isHostFile,
  isSecret,
  isSecretTemplate,
  mcpHosts,
  parseGitRepo,
  stepCommand,
  workspaceLabel,
} from '../environment.ts'
import { layoutOf, refusedPlugins } from '../harness/agents.ts'
import { sha256 } from '../ids.ts'
import { registerSecret } from '../redact.ts'
import { InfraError } from '../sandbox/types.ts'
import type {
  EgressPolicy,
  EnvironmentRecord,
  EnvVars,
  GitWorkspace,
  HarnessDescriptor,
  HostFile,
  McpServer,
  PluginPart,
  PluginRecord,
  PluginSource,
  Secret,
  SecretTemplate,
  SkillPlacement,
  SkillSource,
} from '../types.ts'
import type { PreparedWorkspace } from '../workspace.ts'
import {
  fetchesAtStart,
  type PluginContents,
  type PluginFile,
  PluginProblem,
  pluginCall,
  pluginFiles,
  pluginParts,
  pluginServerName,
  pluginSourceLabel,
  readPlugin,
  samePluginTwice,
  skillCall,
} from './plugins.ts'

/** The harness-neutral skill shape the harness adapters take. */
export type HarnessSkill = {
  name: string
  description: string
  content: string
  files: Array<{ path: string; content: string }>
}

/** An MCP server with its secrets resolved, for the harness adapter. */
export type ResolvedMcpServer =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { transport: 'http' | 'sse'; url: string; headers: Record<string, string> }

export type ResolvedStep = { run: string; timeoutMs: number; cwd?: string }

export type ResolvedEnvironment = {
  record: EnvironmentRecord
  /** Run in each fresh sandbox, in order, before the agent starts. */
  setup: ResolvedStep[]
  /** Handed to the harness adapter. */
  skills: HarnessSkill[]
  /** Written into the harness's repo skill directory. */
  workspaceSkills: HarnessSkill[]
  mcp: Record<string, ResolvedMcpServer>
  /**
   * Workspace-relative, or `~/` for the home directory. A host `file()` is its bytes, and
   * `executable` when its owner may execute it on the host.
   */
  files: Array<{ path: string; content: string | Uint8Array; executable?: true }>
  /** The container's variables, secret values included. Never write this anywhere. */
  vars: Record<string, string>
  /** `to: 'checks'` secrets: only for `c.exec` and setup steps. */
  checkVars: Record<string, string>
  /**
   * Brokered secrets: the sandbox has the placeholders, and these real values stay in the worker
   * for the Docker egress gateway. Never write this anywhere.
   */
  substitutions: BrokeredSecret[]
  /** The tarball of the git tree the workspace starts as, copied in before `files`. */
  workspace?: { tar: string; label: string; commit: string; init?: boolean }
  /** The plugins to copy into the sandbox, each under `PLUGIN_DIR/<name>/`. */
  plugins: ResolvedPlugin[]
}

/**
 * A plugin to place: its files by path relative to its root (the parts `only` keeps), and the keys
 * of its MCP servers in `mcp`, whose `${CLAUDE_PLUGIN_ROOT}` the session fills in.
 */
export type ResolvedPlugin = {
  name: string
  files: PluginFile[]
  parts: PluginPart[]
  servers: string[]
}

/** What else resolving an environment needs: the harness (for its plugin refusals) and the hosts egress allows (null under `allow-all`). */
export type ResolveOptions = {
  harness?: HarnessDescriptor
  allowed?: readonly string[] | null
}

/** A brokered secret, and whether the gateway swaps it in for the agent or only for checks. */
export type BrokeredSecret = Substitution & { phase: 'agent' | 'checks' }

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_SETUP_TIMEOUT = '5m'

type Secrets = { names: string[]; checks: string[]; unset: string[]; brokered: BrokeredSecret[] }

function broker(
  secrets: Secrets,
  name: string,
  value: string,
  hosts: readonly string[],
  where: readonly Substitution['in'][number][] = ['header'],
  phase: BrokeredSecret['phase'] = 'agent',
): string {
  const at = badCharacterAt(value)
  if (at && where.includes('header')) {
    throw new InfraError(
      `${name} has whitespace or a line break in it (character ${at}), so it can't go in a request header. A key copied from a wrapped terminal line picks these up; set it again as one line.`,
    )
  }
  const sub = { name, placeholder: placeholder(), value, hosts: [...hosts], in: [...where], phase }
  secrets.brokered.push(sub)
  return sub.placeholder
}

/** The host value, or its placeholder when it's brokered to `secret.hosts` (else `hosts`). */
function hostValue(
  name: string,
  secret: Secret,
  where: string,
  secrets: Secrets,
  hosts: readonly string[] | undefined = secret.hosts,
) {
  const from = secret.from ?? name
  const value = process.env[from]
  if (!value) {
    if (secret.optional) {
      secrets.unset.push(name)
      return undefined
    }
    const source = from === name ? name : `${name} (from ${from})`
    throw new InfraError(
      `Secret ${source} for ${where} isn't set. Set it in the environment or .env.local.`,
    )
  }
  registerSecret(value)
  if (secret.to === 'checks') secrets.checks.push(name)
  else secrets.names.push(name)
  if (!hosts) return value
  return broker(secrets, name, value, hosts, secret.in, secret.to === 'checks' ? 'checks' : 'agent')
}

/** Each host variable in the template, or with `hosts` one placeholder per variable. */
function template(
  value: SecretTemplate,
  where: string,
  secrets: Secrets,
  hosts?: readonly string[],
): string {
  const placeholders = new Map<string, string>()
  return value.template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name]
    if (!v)
      throw new InfraError(
        `secret.template for ${where} needs ${name}, which isn't set. Set it in the environment or .env.local.`,
      )
    registerSecret(v)
    if (!hosts) return v
    const p = placeholders.get(name) ?? broker(secrets, name, v, hosts)
    placeholders.set(name, p)
    return p
  })
}

/** A `SKILL.md` split into its YAML frontmatter's `name` and `description` and its body. */
export function parseSkillMd(
  text: string,
  where: string,
): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!match) return { body: text }
  let front: unknown
  try {
    front = parseYaml(match[1] ?? '')
  } catch (error) {
    const reason = (error as Error).message.split('\n')[0]
    throw new InfraError(
      `${where}: the SKILL.md frontmatter isn't valid YAML (${reason}). Quote values that contain ": ".`,
    )
  }
  if (front != null && (typeof front !== 'object' || Array.isArray(front))) {
    throw new InfraError(
      `${where}: the SKILL.md frontmatter must be a YAML mapping, e.g. name: my-skill and description: … on their own lines`,
    )
  }
  const field = (key: 'name' | 'description') => {
    const value = (front as Record<string, unknown> | null)?.[key]
    if (value == null) return undefined
    if (typeof value !== 'string') {
      throw new InfraError(`${where}: the SKILL.md ${key} must be a string (got ${typeof value})`)
    }
    return value.trim() || undefined
  }
  return { name: field('name'), description: field('description'), body: match[2] ?? '' }
}

/** A gitignore-style test for `DEFAULT_SKILL_EXCLUDE`-shaped patterns against a skill-relative path. */
export function excludeMatcher(patterns: readonly string[]) {
  const rules = patterns.map((pattern) => {
    const dirOnly = pattern.endsWith('/')
    const body = pattern.replace(/\/+$/, '')
    const anchored = body.includes('/')
    const glob = body
      .replace(/^\/+/, '')
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')
    return { dirOnly, re: new RegExp(`${anchored ? '^' : '(?:^|/)'}${glob}$`) }
  })
  return (path: string, isDir: boolean) =>
    rules.some((r) => (isDir || !r.dirOnly) && r.re.test(path))
}

type LoadedSkill = { skill: HarnessSkill; excluded: string[] }

function parseSkill(dir: string, source: string, exclude: readonly string[]): LoadedSkill {
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const front = parseSkillMd(text, `Skill ${basename(dir)} in ${source}`)
  const name = front.name || basename(dir)
  checkSkill(name, front.description, source)
  const skip = excludeMatcher(exclude)
  const paths: string[] = []
  const excluded: string[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      const isDir = entry.isDirectory()
      if (entry.name === '.git') continue
      if (skip(path, isDir)) excluded.push(isDir ? `${path}/` : path)
      else if (isDir) walk(path)
      else if (entry.isFile() && path !== 'SKILL.md') paths.push(path)
    }
  }
  walk('')
  const files = paths
    .sort()
    .map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') }))
  return {
    skill: { name, description: front.description ?? '', content: front.body, files },
    excluded: excluded.sort(),
  }
}

function checkSkill(name: string, description: string | undefined, source: string) {
  if (!SKILL_NAME.test(name)) {
    throw new InfraError(
      `Skill "${name}" in ${source}: the name must be kebab-case, e.g. my-skill (lower-case letters, digits and -)`,
    )
  }
  if (!description) {
    throw new InfraError(
      `Skill "${name}" in ${source} has no description in its SKILL.md frontmatter. Add a description: line saying when to use it.`,
    )
  }
}

function loadSkills(
  dir: string,
  source: string,
  only?: string[],
  exclude: readonly string[] = DEFAULT_SKILL_EXCLUDE,
): LoadedSkill[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new InfraError(
      `Skill source ${source} isn't a directory. Point it at a skill's directory, or at a directory of skills.`,
    )
  }
  const dirs = existsSync(join(dir, 'SKILL.md'))
    ? [dir]
    : readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
        .map((e) => join(dir, e.name))
        .sort()
  if (dirs.length === 0) {
    throw new InfraError(`Skill source ${source} has no SKILL.md (and no subdirectories with one)`)
  }
  const skills = dirs.map((d) => parseSkill(d, source, exclude))
  if (!only) return skills
  const missing = only.filter((n) => !skills.some((s) => s.skill.name === n))
  if (missing.length) {
    throw new InfraError(
      `only: ${JSON.stringify(missing)} not found in ${source} (found: ${skills.map((s) => s.skill.name).join(', ')})`,
    )
  }
  return skills.filter((s) => only.includes(s.skill.name))
}

async function git(args: string[], cwd: string, what: string) {
  const r = await run('git', args, { cwd })
  if (r.exitCode !== 0) throw new InfraError(`${what} failed: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

/** One clone per source and ref per worker process; the commit is recorded. */
const clones = new Map<string, Promise<{ dir: string; commit: string }>>()

function cloneSkills(root: string, url: string, ref: string | undefined) {
  const key = `${url}#${ref ?? ''}`
  let clone = clones.get(key)
  if (!clone) {
    clone = (async () => {
      const dir = join(
        root,
        '.reeval',
        'cache',
        'skills',
        `${sha256(key).slice(0, 16)}-${process.pid}`,
      )
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const what = `Cloning ${url}${ref ? ` at ${ref}` : ''}`
      await git(['init', '-q'], dir, what)
      await git(['fetch', '-q', '--depth', '1', url, ref ?? 'HEAD'], dir, what)
      await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], dir, what)
      return { dir, commit: await git(['rev-parse', 'HEAD'], dir, what) }
    })()
    clones.set(key, clone)
    clone.catch(() => clones.delete(key))
  }
  return clone
}

const packs = new Map<string, Promise<string>>()

/** `npm pack` into the cache, unpacked; returns the package directory. */
function unpackNpm(root: string, spec: string) {
  let pack = packs.get(spec)
  if (!pack) {
    pack = (async () => {
      const dir = join(
        root,
        '.reeval',
        'cache',
        'skills',
        `npm-${sha256(spec).slice(0, 16)}-${process.pid}`,
      )
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const packed = await run('npm', ['pack', spec, '--silent', '--pack-destination', dir], {
        cwd: dir,
      })
      const tarball = packed.stdout.trim().split('\n').at(-1)
      if (packed.exitCode !== 0 || !tarball) {
        throw new InfraError(`npm pack ${spec} failed: ${packed.stderr.trim()}`)
      }
      const untar = await run('tar', ['-xzf', tarball], { cwd: dir })
      if (untar.exitCode !== 0)
        throw new InfraError(`Unpacking ${spec} failed: ${untar.stderr.trim()}`)
      return join(dir, 'package')
    })()
    packs.set(spec, pack)
    pack.catch(() => packs.delete(spec))
  }
  return pack
}

type Found = { skills: LoadedSkill[]; source: string; commit: string | null }

async function resolveSkills(root: string, s: SkillSource): Promise<Found> {
  switch (s.source) {
    case 'local': {
      const label = `local:${relative(root, s.path).split(sep).join('/') || '.'}`
      return { skills: loadSkills(s.path, label, s.only, s.exclude), source: label, commit: null }
    }
    case 'git': {
      const { url } = parseGitRepo(s.repo)
      const { dir, commit } = await cloneSkills(root, url, s.ref)
      // Without a path, a repository of skills under skills/ works as it does for skill.registry.
      const path =
        s.path ??
        (!existsSync(join(dir, 'SKILL.md')) && existsSync(join(dir, 'skills')) ? 'skills' : '')
      const label = `${s.repo}${s.ref ? `#${s.ref}` : ''}${path ? `:${path}` : ''}`
      return {
        skills: loadSkills(join(dir, path), label, s.only, s.exclude),
        source: label,
        commit,
      }
    }
    case 'registry': {
      const [repo = '', name = ''] = s.id.split('@')
      const { dir, commit } = await cloneSkills(root, `https://github.com/${repo}.git`, s.version)
      const label = `registry:${s.id}${s.version ? `#${s.version}` : ''}`
      const at = existsSync(join(dir, 'skills')) ? join(dir, 'skills') : dir
      return { skills: loadSkills(at, label, [name]), source: label, commit }
    }
    case 'npm': {
      const dir = await unpackNpm(root, s.spec)
      const spec = isAbsolute(s.spec) ? relative(root, s.spec).split(sep).join('/') : s.spec
      const label = `npm:${spec}:${s.path}`
      return {
        skills: loadSkills(join(dir, s.path), label, s.only, s.exclude),
        source: label,
        commit: null,
      }
    }
    case 'inline': {
      checkSkill(s.name, s.description, 'skill.inline')
      const files = Object.entries(s.files)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, content]) => ({ path, content }))
      const skill = { name: s.name, description: s.description, content: s.content, files }
      return {
        skills: [{ skill, excluded: [] }],
        source: 'inline',
        commit: null,
      }
    }
  }
}

type FoundPlugin = { contents: PluginContents; source: string; commit: string | null }

async function resolvePlugin(root: string, p: PluginSource, where: string): Promise<FoundPlugin> {
  let dir: string
  let commit: string | null = null
  switch (p.source) {
    case 'local':
      dir = p.path
      break
    case 'git': {
      const clone = await cloneSkills(root, parseGitRepo(p.repo).url, p.ref)
      dir = join(clone.dir, p.path ?? '')
      commit = clone.commit
      break
    }
    case 'npm':
      dir = join(await unpackNpm(root, p.spec), p.path ?? '')
      break
  }
  try {
    const contents = readPlugin(dir, pluginCall(p, root), p.only)
    return { contents, source: pluginSourceLabel(p, root), commit }
  } catch (error) {
    if (error instanceof PluginProblem) throw new InfraError(`${where}: ${error.message}`)
    throw error
  }
}

const skillHash = (s: HarnessSkill) => sha256(JSON.stringify(s))

const readHostFile = (f: HostFile, where: string): Uint8Array => {
  if (!existsSync(f.path))
    throw new InfraError(
      `${f.path} for ${where} doesn't exist. file() paths resolve against the file that calls it, or reeval.yaml's directory.`,
    )
  return readFileSync(f.path)
}

/**
 * Layers the environment (root first; a later layer wins on shared keys, and each such key is
 * an override), over the options `env` merged down the cascade. `where` names the attempt, and
 * `rulesFile` is the workspace file the harness's agent reads `rules` from.
 */
export async function resolveEnvironment(
  environment: AppliedEnvironment,
  optionsEnv: EnvVars,
  root: string,
  where: string,
  rulesFile: string,
  egress: EgressPolicy = 'allow-all',
  prepared: (w: GitWorkspace) => PreparedWorkspace | undefined = () => undefined,
  options: ResolveOptions = {},
): Promise<ResolvedEnvironment> {
  const envWhere = `environment ${environment.name} (${where})`
  const overrides = new Set<string>()
  const env: EnvVars = { ...optionsEnv }
  const files = new Map<string, string | HostFile>()
  const mcp = new Map<string, McpServer>()
  const skills = new Map<
    string,
    LoadedSkill & {
      placement: SkillPlacement
      source: string
      commit: string | null
      call: string
      plugin?: string
    }
  >()
  const plugins = new Map<string, FoundPlugin>()
  let rules: string | HostFile | undefined
  const setup: ResolvedStep[] = []
  const seen = { env: new Set<string>(), files: new Set<string>(), mcp: new Set<string>() }

  let egressSet = false
  let workspace: GitWorkspace | undefined
  let sandboxSet = false
  for (const layer of environment.layers) {
    const { spec } = layer
    if (spec.sandbox !== undefined) {
      if (sandboxSet) overrides.add('sandbox')
      sandboxSet = true
    }
    if (spec.workspace !== undefined) {
      if (workspace) overrides.add('workspace')
      workspace = spec.workspace
    }
    if (spec.egress !== undefined) {
      if (egressSet) overrides.add('egress')
      egressSet = true
    }
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      if (seen.env.has(k)) overrides.add(`env.${k}`)
      seen.env.add(k)
      env[k] = v
    }
    for (const [path, v] of Object.entries(spec.files ?? {})) {
      if (seen.files.has(path)) overrides.add(`files.${path}`)
      seen.files.add(path)
      files.set(path, v)
    }
    if (spec.rules !== undefined) {
      if (rules !== undefined) overrides.add('rules')
      rules = spec.rules
    }
    for (const [name, server] of Object.entries(spec.mcp ?? {})) {
      if (seen.mcp.has(name)) overrides.add(`mcp.${name}`)
      seen.mcp.add(name)
      mcp.set(name, server)
    }
    for (const step of spec.setup ?? []) {
      const s = typeof step === 'string' ? { run: step as string } : step
      setup.push({
        run: s.run,
        timeoutMs: parseDuration(s.timeout ?? DEFAULT_SETUP_TIMEOUT),
        ...(s.cwd ? { cwd: s.cwd } : {}),
      })
    }
    const layerSkills = new Set<string>()
    for (const source of spec.skills ?? []) {
      const found = await resolveSkills(root, source)
      for (const loaded of found.skills) {
        const name = loaded.skill.name
        if (skills.has(name) && !layerSkills.has(name)) overrides.add(`skills.${name}`)
        layerSkills.add(name)
        skills.delete(name)
        skills.set(name, {
          ...loaded,
          placement: source.placement,
          source: found.source,
          commit: found.commit,
          call: skillCall(source, root),
        })
      }
    }
    const layerPlugins = new Map<string, string>()
    for (const source of spec.plugins ?? []) {
      const found = await resolvePlugin(root, source, envWhere)
      const { name, call } = found.contents
      const first = layerPlugins.get(name)
      if (first) {
        throw new InfraError(`${envWhere}: ${samePluginTwice(layer.name, name, first, call)}`)
      }
      if (plugins.has(name)) overrides.add(`plugins.${name}`)
      layerPlugins.set(name, call)
      plugins.delete(name)
      plugins.set(name, found)
    }
  }

  const pluginList = [...plugins.values()]
  const harness = options.harness ?? { kind: 'fake' }
  const refused = refusedPlugins(
    harness,
    pluginList.map((p) => p.contents),
    {
      skills: [...skills.values()]
        .filter((s) => s.placement === 'harness')
        .map((s) => ({ name: s.skill.name, call: s.call })),
      mcp: [...mcp.keys()],
    },
  )
  if (refused) throw new InfraError(`${envWhere}: ${refused}`)
  const allowed = options.allowed ?? null
  const fetches = fetchesAtStart(
    pluginList.map((p) => p.contents),
    allowed,
  )
  if (fetches.refusal) throw new InfraError(`${envWhere}: ${fetches.refusal}`)
  const pluginSkills: Array<
    LoadedSkill & { plugin: string; source: string; commit: string | null }
  > = []
  const resolvedPlugins: ResolvedPlugin[] = []
  const pluginRecords: PluginRecord[] = []
  for (const { contents: p, source, commit } of pluginList) {
    const loaded = p.skills.length
      ? loadSkills(
          join(p.dir, 'skills'),
          source,
          p.skills.map((s) => s.name),
        )
      : []
    for (const l of loaded) pluginSkills.push({ ...l, plugin: p.name, source, commit })
    const servers: string[] = []
    for (const [name, server] of Object.entries(p.mcp)) {
      if (allowed && server.transport !== 'stdio') {
        const host = new URL(server.url).hostname
        if (!hostAllowed(allowed, host)) {
          throw new InfraError(
            `${envWhere}: the ${p.name} plugin's MCP server "${name}" is at ${host}, which egress doesn't allow: add it to egress.allow`,
          )
        }
      }
      const key = pluginServerName(p.name, name)
      mcp.set(key, server)
      servers.push(key)
    }
    const files = pluginFiles(p)
    resolvedPlugins.push({ name: p.name, files, parts: p.kept, servers })
    pluginRecords.push({
      name: p.name,
      source,
      marketplace: null,
      commit,
      sha256: sha256(JSON.stringify(files.map((f) => [f.path, sha256(f.content)]))),
      build: null,
      parts: pluginParts(
        p,
        loaded.map((l) => l.skill.name),
      ),
    })
  }

  const secrets: Secrets = { names: [], checks: [], unset: [], brokered: [] }
  const vars: Record<string, string> = {}
  const checkVars: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (!isSecret(value)) {
      vars[name] = value
      continue
    }
    const resolved = hostValue(name, value, envWhere, secrets)
    if (resolved === undefined) continue
    if (value.to === 'checks') checkVars[name] = resolved
    else vars[name] = resolved
  }
  const secretOf = (
    value: string | Secret | SecretTemplate,
    key: string,
    hosts?: readonly string[],
  ): string | undefined => {
    if (typeof value === 'string') return value
    if (isSecretTemplate(value)) return template(value, envWhere, secrets, hosts)
    return hostValue(key, value, envWhere, secrets, value.hosts ?? hosts)
  }
  const resolvedMcp: Record<string, ResolvedMcpServer> = {}
  for (const [name, s] of mcp) {
    if (s.transport === 'stdio') {
      const e: Record<string, string> = {}
      for (const [k, v] of Object.entries(s.env)) {
        const r = secretOf(v, k)
        if (r !== undefined) e[k] = r
      }
      resolvedMcp[name] = { transport: 'stdio', command: s.command, args: s.args, env: e }
    } else {
      const h: Record<string, string> = {}
      const hosts = mcpHosts(s.url)
      for (const [k, v] of Object.entries(s.headers)) {
        const r = secretOf(v, k, hosts)
        if (r !== undefined) h[k] = r
      }
      resolvedMcp[name] = { transport: s.transport, url: s.url, headers: h }
    }
  }

  const fileList: ResolvedEnvironment['files'] = [...files].map(([path, v]) => ({
    path,
    content: isHostFile(v) ? readHostFile(v, envWhere) : v,
    ...(isHostFile(v) && statSync(v.path).mode & 0o100 ? { executable: true as const } : {}),
  }))
  const rulesContent =
    rules === undefined
      ? undefined
      : isHostFile(rules)
        ? Buffer.from(readHostFile(rules, envWhere)).toString('utf8')
        : rules
  const skillList = [...skills.values()]
  const skillRecords = [
    ...skillList.map(({ skill, placement, source, commit, excluded }) => ({
      name: skill.name,
      source,
      commit,
      sha256: skillHash(skill),
      placement,
      excluded,
    })),
    ...pluginSkills.map(({ skill, source, commit, excluded, plugin }) => ({
      name: skill.name,
      source,
      commit,
      sha256: skillHash(skill),
      placement: 'harness' as const,
      excluded,
      plugin,
    })),
  ]
  const fileRecords = fileList.map((f) => ({ path: f.path, sha256: sha256(f.content) }))
  const executable = fileList.flatMap((f) => (f.executable ? [f.path] : []))
  // Hashed apart from the files, so one environment has one digest whichever file its rules go to.
  const rulesRecord =
    rulesContent === undefined ? undefined : { path: rulesFile, sha256: sha256(rulesContent) }
  if (rulesContent !== undefined) fileList.push({ path: rulesFile, content: rulesContent })
  const secretNames = [...new Set([...secrets.names, ...secrets.checks])].sort()
  const brokered = secrets.brokered
    .map((b) => JSON.stringify([b.name, b.hosts, b.in, b.phase]))
    .sort()
  const brokeredNames = [...new Set(secrets.brokered.map((b) => b.name))].sort()
  const varNames = Object.keys(vars)
    .filter((n) => !secrets.names.includes(n))
    .sort()
  const literalVars = Object.fromEntries(varNames.map((n) => [n, vars[n]]))
  const mcpShape = Object.fromEntries(
    Object.entries(resolvedMcp).map(([name, s]) =>
      s.transport === 'stdio'
        ? [name, { command: s.command, args: s.args, env: Object.keys(s.env).sort() }]
        : [name, { transport: s.transport, url: s.url, headers: Object.keys(s.headers).sort() }],
    ),
  )
  const tree = workspace && prepared(workspace)
  if (workspace && !tree) {
    throw new InfraError(
      `The workspace git(${JSON.stringify(workspaceLabel(workspace))}) for ${envWhere} wasn't prepared before the run started`,
    )
  }
  const workspaceRecord =
    workspace && tree
      ? {
          source: isAbsolute(workspace.url)
            ? relative(root, workspace.url).split(sep).join('/') || '.'
            : workspace.repo,
          ref: workspace.ref ?? null,
          path: workspace.path ?? null,
          commit: tree.commit,
          tree: tree.tree,
          ...(workspace.init ? { init: true } : {}),
        }
      : undefined
  const digest = `sha256:${sha256(
    JSON.stringify({
      setup,
      skills: skillRecords.map((s) => [s.name, s.sha256, s.placement]),
      mcp: mcpShape,
      files: fileRecords,
      ...(executable.length ? { executable } : {}),
      rules: rulesRecord?.sha256,
      vars: literalVars,
      secrets: secretNames,
      checks: [...secrets.checks].sort(),
      unset: [...secrets.unset].sort(),
      brokered,
      ...(egress === 'allow-all'
        ? {}
        : { egress: typeof egress === 'string' ? egress : [...egress.allow].sort() }),
      ...(pluginRecords.length
        ? { plugins: pluginRecords.map((p, i) => [p.name, p.sha256, resolvedPlugins[i]?.parts]) }
        : {}),
      ...(workspaceRecord
        ? {
            workspace: workspaceRecord.init ? [workspaceRecord.tree, 'init'] : workspaceRecord.tree,
          }
        : {}),
    }),
  )}`
  return {
    record: {
      name: environment.name,
      parent: environment.parent,
      overrides: [...overrides],
      digest,
      setup: setup.map(stepCommand),
      skills: skillRecords,
      mcp: Object.keys(resolvedMcp).sort(),
      ...(pluginRecords.length ? { plugins: pluginRecords } : {}),
      files: rulesRecord ? [...fileRecords, rulesRecord] : fileRecords,
      vars: varNames,
      secrets: secretNames,
      brokered: brokeredNames,
      unset: [...secrets.unset].sort(),
      egress,
      ...(workspaceRecord ? { workspace: workspaceRecord } : {}),
    },
    setup,
    skills: [
      ...skillList.filter((s) => s.placement === 'harness').map((s) => s.skill),
      ...(layoutOf(harness).pluginPlacement === 'flat' ? pluginSkills.map((s) => s.skill) : []),
    ],
    workspaceSkills: skillList.filter((s) => s.placement === 'workspace').map((s) => s.skill),
    mcp: resolvedMcp,
    files: fileList,
    vars,
    checkVars,
    substitutions: secrets.brokered,
    plugins: resolvedPlugins,
    ...(workspace && tree
      ? {
          workspace: {
            tar: tree.tar,
            label: workspaceLabel(workspace),
            commit: tree.commit,
            ...(workspace.init ? { init: true } : {}),
          },
        }
      : {}),
  }
}

/** A skill as a `SKILL.md` file plus its other files, for writing into a directory. */
export function skillFiles(skill: HarnessSkill): Array<{ path: string; content: string }> {
  const front = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n`
  return [{ path: 'SKILL.md', content: `${front}${skill.content}` }, ...skill.files]
}
