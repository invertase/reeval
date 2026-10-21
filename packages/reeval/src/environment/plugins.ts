// A plugin directory as reeval reads it, in Claude Code's layout: `.claude-plugin/plugin.json` and
// the parts beside it. Synchronous and host-only, so the plan reads a local plugin and the worker
// reads every plugin (git and npm ones once fetched) the same way.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { hostAllowed } from '@reeval/sandbox-docker'
import { parse as parseYaml } from 'yaml'
import { sha256 } from '../ids.ts'
import type {
  EnvironmentLayer,
  EnvVars,
  McpServer,
  PluginBuild,
  PluginPart,
  PluginRecord,
  PluginSource,
  SandboxDescriptor,
  SecretTemplate,
  SkillSource,
} from '../types.ts'

export const PLUGIN_PARTS: readonly PluginPart[] = [
  'skills',
  'agents',
  'commands',
  'hooks',
  'mcp',
  'rules',
]

/** Where each part lives in a plugin, for messages. */
export const PART_PATHS: Record<PluginPart, string> = {
  skills: 'skills/',
  agents: 'agents/',
  commands: 'commands/',
  hooks: 'hooks/hooks.json',
  mcp: '.mcp.json',
  rules: 'rules/',
}

/** A plugin's manifest, relative to its directory. */
export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json'
/** Other harnesses' plugin manifests, relative to the plugin's directory. */
export const OTHER_MANIFESTS = [
  'plugin.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
]

/** Whether a manifest is one an agent reads: any but a root `plugin.json` without the schema. */
function readsAsManifest(dir: string, path: string): boolean {
  const file = join(dir, path)
  if (!existsSync(file)) return false
  if (path !== 'plugin.json') return true
  try {
    const schema = (JSON.parse(readFileSync(file, 'utf8')) as { $schema?: unknown }).$schema
    return typeof schema === 'string' && schema.startsWith('https://agent-plugins.org/schemas/')
  } catch {
    return false
  }
}
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Manifest keys that move a part from its default place, which reeval doesn't follow. */
const CUSTOM_PATHS = ['skills', 'agents', 'commands', 'hooks', 'outputStyles', 'lspServers']
/** Where the session copies each plugin, under the sandbox's home. */
export const PLUGIN_DIR = '~/.reeval/plugins'
/** Plugin MCP servers name their own directory with this; the session substitutes it. */
export const PLUGIN_ROOT_VAR = 'CLAUDE_PLUGIN_ROOT'
// biome-ignore lint/suspicious/noTemplateCurlyInString: how a plugin writes the variable
export const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}'

/** A plugin's content that reeval can't place, in words for the plan or the attempt. */
export class PluginProblem extends Error {
  override name = 'PluginProblem'
}

/** `plugin.local('plugins/review')`, as messages name a plugin before its manifest is read. */
export function pluginCall(p: PluginSource, root?: string): string {
  const arg =
    p.source === 'local'
      ? root
        ? relative(root, p.path).split(sep).join('/') || '.'
        : p.path
      : p.source === 'git'
        ? p.repo
        : p.spec
  return `plugin.${p.source}('${arg}')`
}

/**
 * A plugin's source as the record writes it: `local:plugins/review`,
 * `github:acme/agent-plugins#v1.2.0:plugins/review` or `npm:@acme/review-plugin@1.2.0`.
 */
export function pluginSourceLabel(p: PluginSource, root: string): string {
  const rel = (path: string) => relative(root, path).split(sep).join('/') || '.'
  switch (p.source) {
    case 'local':
      return `local:${rel(p.path)}`
    case 'git':
      return `${p.repo}${p.ref ? `#${p.ref}` : ''}${p.path ? `:${p.path}` : ''}`
    case 'npm':
      return `npm:${isAbsolute(p.spec) ? rel(p.spec) : p.spec}${p.path ? `:${p.path}` : ''}`
  }
}

/** What a plugin directory has, and what of it `only` keeps. */
export type PluginContents = {
  name: string
  dir: string
  /** For messages: `plugin.local('plugins/review')`. */
  call: string
  /** The parts it has, in `PLUGIN_PARTS` order. */
  has: PluginPart[]
  /** The parts it places: `has`, narrowed by `only`. */
  kept: PluginPart[]
  /** Skill directories under `skills/` and the names their `SKILL.md` gives them. */
  skills: Array<{ dir: string; name: string }>
  agents: string[]
  commands: string[]
  /** Hook events, and the commands its hooks run. */
  hooks: { events: string[]; commands: string[] }
  mcp: Record<string, McpServer>
  rules: string[]
  /** Whether it bundles ChatGPT apps (Codex's `.app.json`, or the manifest's `apps`). */
  apps: boolean
  /**
   * The other harnesses' manifests it has, which some read before its `.claude-plugin/plugin.json`:
   * of {@link OTHER_MANIFESTS}, a root `plugin.json` only with an Agent Plugins `$schema`.
   */
  manifests: string[]
  /** The manifest's text, without `mcpServers` when `only` leaves MCP out. */
  manifest: string
}

const readJson = (path: string, what: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new PluginProblem(`${what} isn't valid JSON (${(error as Error).message.split('\n')[0]})`)
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true

const filesIn = (dir: string, test: (name: string) => boolean) =>
  isDir(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && test(e.name))
        .map((e) => e.name)
        .sort()
    : []

/** A skill's name from its `SKILL.md` frontmatter, else its directory's; `loadSkills` checks it. */
function skillName(dir: string): string {
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  try {
    const front = match ? parseYaml(match[1] ?? '') : undefined
    const name = isRecord(front) && typeof front.name === 'string' ? front.name.trim() : ''
    return name || basename(dir)
  } catch {
    return basename(dir)
  }
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** `.mcp.json`'s servers as reeval's: `${VAR}` in a header is a secret template, a whole env value a secret. */
function mcpServers(raw: unknown, plugin: string, file: string): Record<string, McpServer> {
  const map = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : raw
  if (!isRecord(map)) {
    throw new PluginProblem(`the ${plugin} plugin's ${file} must map server names to servers`)
  }
  const out: Record<string, McpServer> = {}
  for (const [name, s] of Object.entries(map)) {
    const what = `the ${plugin} plugin's MCP server "${name}"`
    if (!isRecord(s)) throw new PluginProblem(`${what} in ${file} must be an object`)
    const type = s.type ?? (s.url !== undefined ? 'http' : 'stdio')
    const strings = (v: unknown, key: string): Record<string, string> => {
      if (v === undefined) return {}
      if (!isRecord(v) || Object.values(v).some((x) => typeof x !== 'string')) {
        throw new PluginProblem(`${what}: ${key} in ${file} must map names to strings`)
      }
      return v as Record<string, string>
    }
    if (type === 'stdio') {
      const { command, args = [] } = s
      if (typeof command !== 'string' || !command) {
        throw new PluginProblem(`${what} in ${file} needs a command, or a type and url`)
      }
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new PluginProblem(`${what}: args in ${file} must be a list of strings`)
      }
      const variable = [command, ...(args as string[])].find((v) =>
        v.replaceAll(PLUGIN_ROOT, '').includes('${'),
      )
      if (variable !== undefined) {
        throw new PluginProblem(
          `${what}: ${JSON.stringify(variable)} in ${file} names a variable; reeval fills in only \${${PLUGIN_ROOT_VAR}} in a command and its args, so pass a host variable through env, e.g. "env": { "TOKEN": "\${TOKEN}" }`,
        )
      }
      const env: EnvVars = {}
      for (const [k, v] of Object.entries(strings(s.env, 'env'))) {
        const whole = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v)
        if (whole && whole[1] !== PLUGIN_ROOT_VAR) {
          env[k] = { kind: 'secret', from: whole[1] as string }
        } else if (v.replaceAll(PLUGIN_ROOT, '').includes('${')) {
          throw new PluginProblem(
            `${what}: env.${k} in ${file} puts a variable inside a longer value; reeval reads a host variable only as the whole value, e.g. "\${${k}}"`,
          )
        } else env[k] = v
      }
      out[name] = { kind: 'mcp', transport: 'stdio', command, args: args as string[], env }
      continue
    }
    if (type !== 'http' && type !== 'sse') {
      throw new PluginProblem(
        `${what} in ${file} has type ${JSON.stringify(type)}; reeval takes stdio, http and sse`,
      )
    }
    if (typeof s.url !== 'string' || !URL.canParse(s.url) || s.url.includes('${')) {
      throw new PluginProblem(`${what} in ${file} needs a url, written out in full`)
    }
    const headers: Record<string, string | SecretTemplate> = {}
    for (const [k, v] of Object.entries(strings(s.headers, 'headers'))) {
      headers[k] = VAR_REF.test(v) ? { kind: 'secret-template', template: v } : v
      VAR_REF.lastIndex = 0
    }
    out[name] = { kind: 'mcp', transport: type, url: s.url, headers }
  }
  return out
}

/** The commands a `hooks/hooks.json` runs, by event. */
function hookCommands(raw: unknown, plugin: string): { events: string[]; commands: string[] } {
  const hooks = isRecord(raw) && isRecord(raw.hooks) ? raw.hooks : undefined
  if (!hooks) {
    throw new PluginProblem(
      `the ${plugin} plugin's hooks/hooks.json needs a hooks object, e.g. { "hooks": { "SessionStart": [...] } }`,
    )
  }
  const commands: string[] = []
  for (const entries of Object.values(hooks)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const hook of isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : []) {
        if (isRecord(hook) && typeof hook.command === 'string') commands.push(hook.command)
      }
    }
  }
  return { events: Object.keys(hooks).sort(), commands }
}

/**
 * Reads the plugin at `dir`: its manifest, the parts it has and what `only` keeps. Throws a
 * `PluginProblem` for a plugin reeval can't place as written.
 */
export function readPlugin(
  dir: string,
  call: string,
  only?: readonly PluginPart[],
): PluginContents {
  if (!isDir(dir)) throw new PluginProblem(`${call} isn't a directory`)
  const manifestPath = join(dir, PLUGIN_MANIFEST)
  if (!existsSync(manifestPath)) throw new PluginProblem(`${call} has no ${PLUGIN_MANIFEST}`)
  const manifest = readJson(manifestPath, `${call}'s ${PLUGIN_MANIFEST}`)
  if (!isRecord(manifest) || typeof manifest.name !== 'string' || !NAME.test(manifest.name)) {
    throw new PluginProblem(
      `${call}'s ${PLUGIN_MANIFEST} needs a name in kebab-case, e.g. "name": "review" (got ${JSON.stringify(isRecord(manifest) ? manifest.name : manifest)})`,
    )
  }
  const name = manifest.name
  const custom = CUSTOM_PATHS.filter((k) => manifest[k] !== undefined)
  if (custom.length) {
    throw new PluginProblem(
      `the ${name} plugin's manifest sets ${custom.map((k) => `"${k}"`).join(', ')}, which reeval doesn't read: keep each part in its default place (skills/, agents/, commands/, hooks/hooks.json)`,
    )
  }
  const skills = isDir(join(dir, 'skills'))
    ? readdirSync(join(dir, 'skills'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, 'skills', e.name, 'SKILL.md')))
        .map((e) => ({ dir: e.name, name: skillName(join(dir, 'skills', e.name)) }))
        .sort((a, b) => (a.dir < b.dir ? -1 : 1))
    : []
  const md = (n: string) => n.endsWith('.md')
  const agents = filesIn(join(dir, 'agents'), md).map((n) => n.slice(0, -3))
  const commands = filesIn(join(dir, 'commands'), md).map((n) => n.slice(0, -3))
  const hooksFile = join(dir, 'hooks', 'hooks.json')
  const hooks = existsSync(hooksFile)
    ? hookCommands(readJson(hooksFile, `the ${name} plugin's hooks/hooks.json`), name)
    : { events: [], commands: [] }
  let mcp: Record<string, McpServer> = {}
  if (manifest.mcpServers !== undefined) {
    const from = manifest.mcpServers
    mcp =
      typeof from === 'string'
        ? mcpServers(readJson(join(dir, from), `the ${name} plugin's ${from}`), name, from)
        : mcpServers(from, name, PLUGIN_MANIFEST)
  } else if (existsSync(join(dir, '.mcp.json'))) {
    mcp = mcpServers(
      readJson(join(dir, '.mcp.json'), `the ${name} plugin's .mcp.json`),
      name,
      '.mcp.json',
    )
  }
  const rules = filesIn(join(dir, 'rules'), (n) => n.endsWith('.md') || n.endsWith('.mdc'))
  const found: Record<PluginPart, boolean> = {
    skills: skills.length > 0,
    agents: agents.length > 0,
    commands: commands.length > 0,
    hooks: hooks.events.length > 0,
    mcp: Object.keys(mcp).length > 0,
    rules: rules.length > 0,
  }
  const has = PLUGIN_PARTS.filter((p) => found[p])
  if (!has.length) {
    throw new PluginProblem(
      `the ${name} plugin has nothing to place: no skills/*/SKILL.md, agents/*.md, commands/*.md, hooks/hooks.json, .mcp.json or rules/`,
    )
  }
  const missing = (only ?? []).filter((p) => !found[p])
  if (missing.length) {
    const list = (only ?? []).map((p) => `'${p}'`).join(', ')
    throw new PluginProblem(
      missing.length === only?.length
        ? `the ${name} plugin has no ${missing.join(' or ')}, so only: [${list}] matches nothing (it has ${has.join(', ')})`
        : `the ${name} plugin has no ${missing.join(' or ')}, which only: [${list}] names (it has ${has.join(', ')})`,
    )
  }
  const kept = only ? PLUGIN_PARTS.filter((p) => only.includes(p)) : has
  const { mcpServers: _, ...rest } = manifest
  return {
    name,
    dir,
    call,
    has,
    kept,
    skills: kept.includes('skills') ? skills : [],
    agents: kept.includes('agents') ? agents : [],
    commands: kept.includes('commands') ? commands : [],
    hooks: kept.includes('hooks') ? hooks : { events: [], commands: [] },
    mcp: kept.includes('mcp') ? mcp : {},
    rules: kept.includes('rules') ? rules : [],
    apps: manifest.apps !== undefined || existsSync(join(dir, '.app.json')),
    manifests: OTHER_MANIFESTS.filter((m) => readsAsManifest(dir, m)),
    manifest:
      kept.includes('mcp') || manifest.mcpServers === undefined
        ? readFileSync(manifestPath, 'utf8')
        : `${JSON.stringify(rest, null, 2)}\n`,
  }
}

/** A plugin file to place, `executable` when its owner may execute it on the host. */
export type PluginFile = { path: string; content: Uint8Array; executable?: true }

/** The paths a part keeps out of the sandbox when `only` leaves it out. */
const PART_FILES: Record<PluginPart, (path: string) => boolean> = {
  skills: (p) => p.startsWith('skills/'),
  agents: (p) => p.startsWith('agents/'),
  commands: (p) => p.startsWith('commands/'),
  hooks: (p) => p.startsWith('hooks/'),
  mcp: (p) => p === '.mcp.json',
  rules: (p) => p.startsWith('rules/'),
}

/**
 * The files to place, by path relative to the plugin's root: its tree without `.git`, without the
 * parts `only` leaves out, and with the manifest as `readPlugin` gives it.
 */
export function pluginFiles(p: PluginContents): PluginFile[] {
  const dropped = PLUGIN_PARTS.filter((part) => !p.kept.includes(part)).map((x) => PART_FILES[x])
  const out: PluginFile[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(p.dir, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && path !== PLUGIN_MANIFEST && !dropped.some((d) => d(path))) {
        const full = join(p.dir, path)
        const executable = (statSync(full).mode & 0o100) !== 0
        out.push({
          path,
          content: readFileSync(full),
          ...(executable ? { executable: true as const } : {}),
        })
      }
    }
  }
  walk('')
  out.push({ path: PLUGIN_MANIFEST, content: Buffer.from(p.manifest) })
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** The record's `parts`: names of what the plugin placed. */
export const pluginParts = (p: PluginContents, skillNames: string[]): PluginRecord['parts'] => ({
  skills: skillNames,
  agents: p.agents,
  commands: p.commands,
  hooks: p.hooks.events,
  mcp: Object.keys(p.mcp).sort(),
  rules: p.rules.length > 0,
})

/** A plugin's MCP server as the environment's `mcp` names it. */
export const pluginServerName = (plugin: string, server: string) => `${plugin}:${server}`

const read = new Map<string, PluginContents | PluginProblem>()

/**
 * A local plugin as the plan reads it, once per process: its contents, or the problem with it.
 * Git and npm plugins aren't fetched until an attempt, so the plan has nothing for them.
 */
export function localPlugin(
  p: PluginSource,
  root?: string,
): PluginContents | PluginProblem | undefined {
  if (p.source !== 'local') return undefined
  const key = JSON.stringify([p.path, p.only, root])
  let found = read.get(key)
  if (!found) {
    try {
      found = readPlugin(p.path, pluginCall(p, root), p.only)
    } catch (error) {
      if (!(error instanceof PluginProblem)) throw error
      found = error
    }
    read.set(key, found)
  }
  return found
}

/**
 * The MCP servers the layers' local plugins bring, as `<plugin>:<server>`: the plan's egress and
 * secrets see them as they see `mcp`. A later layer's plugin replaces an earlier one of its name.
 */
export function localPluginServers(layers: readonly EnvironmentLayer[]): Map<string, McpServer> {
  const plugins = new Map<string, PluginContents>()
  for (const { spec } of layers) {
    for (const source of spec.plugins ?? []) {
      const p = localPlugin(source)
      if (p && !(p instanceof PluginProblem)) plugins.set(p.name, p)
    }
  }
  const out = new Map<string, McpServer>()
  for (const p of plugins.values()) {
    for (const [name, server] of Object.entries(p.mcp))
      out.set(pluginServerName(p.name, name), server)
  }
  return out
}

/** Why one environment can't list two plugins of one name: neither would replace the other. */
export const samePluginTwice = (environment: string, name: string, first: string, second: string) =>
  `environment ${environment} lists two plugins named "${name}", ${first} and ${second}: rename one, or leave one out`

/** The first local plugin a layer lists twice by name, as `samePluginTwice` words it. */
export function duplicateLocalPlugin(
  layers: readonly EnvironmentLayer[],
  root?: string,
): string | undefined {
  for (const { name: environment, spec } of layers) {
    const calls = new Map<string, string>()
    for (const source of spec.plugins ?? []) {
      const p = localPlugin(source, root)
      if (!p || p instanceof PluginProblem) continue
      const first = calls.get(p.name)
      if (first) return samePluginTwice(environment, p.name, first, p.call)
      calls.set(p.name, p.call)
    }
  }
  return undefined
}

/** A plugin's build as commands and where they run: `cwd` relative to the source's root, or null for the plugin's directory. */
export function buildSteps(build: PluginBuild): { run: string[]; cwd: string | null } {
  if (typeof build === 'string') return { run: [build], cwd: null }
  if (Array.isArray(build)) return { run: [...build], cwd: null }
  const { run, cwd } = build as Exclude<PluginBuild, string | string[]>
  return { run: typeof run === 'string' ? [run] : [...run], cwd: cwd ?? null }
}

/** The layered plugins with a build: what preflight builds into the attempt's image, in order. */
export const builtPlugins = (layers: readonly EnvironmentLayer[]): PluginSource[] =>
  layeredPlugins(layers).filter((p) => p.build !== undefined)

/**
 * Why a plugin's build can't run in `sandbox`, or undefined: a build runs in a Docker image
 * layer. `name` is the plugin's, once its manifest is read; else the call names it.
 */
export function buildRefusal(
  p: PluginSource,
  sandbox: SandboxDescriptor,
  name?: string,
  root?: string,
): string | undefined {
  if (p.build === undefined || sandbox.kind === 'docker') return undefined
  return `${name ? `plugin "${name}"` : pluginCall(p, root)} has a build, which runs in a Docker image layer: use docker()`
}

/** ` + 2 plugin builds` in an image's label, or nothing without one. */
export const pluginBuildsLabel = (plugins: readonly unknown[] = []) =>
  plugins.length ? ` + ${plugins.length} plugin build${plugins.length === 1 ? '' : 's'}` : ''

/** Names one plugin build the same way in preflight and in the attempt that places it. */
export const pluginBuildId = (p: PluginSource) => sha256(JSON.stringify(p)).slice(0, 16)

/** The paths in a plugin's directory that hold the parts `kept` leaves out. */
export const droppedPaths = (kept: readonly PluginPart[]): string[] =>
  PLUGIN_PARTS.filter((p) => !kept.includes(p)).map((p) =>
    p === 'mcp' ? '.mcp.json' : p === 'hooks' ? 'hooks' : p,
  )

/** The plugins the layers place, layered: a later layer's local plugin replaces one of its name. */
export function layeredPlugins(layers: readonly EnvironmentLayer[]): PluginSource[] {
  const out: PluginSource[] = []
  for (const { spec } of layers) {
    for (const source of spec.plugins ?? []) {
      const p = localPlugin(source)
      const name = p && !(p instanceof PluginProblem) ? p.name : undefined
      const same = out.findIndex((o) => {
        const q = localPlugin(o)
        return name !== undefined && q && !(q instanceof PluginProblem) && q.name === name
      })
      if (same >= 0) out.splice(same, 1)
      out.push(source)
    }
  }
  return out
}

/** `skill.local('skills')`, as plugin messages name the skill source a clash is with. */
export function skillCall(s: SkillSource, root?: string): string {
  switch (s.source) {
    case 'local':
      return `skill.local('${root ? relative(root, s.path).split(sep).join('/') || '.' : s.path}')`
    case 'git':
      return `skill.git('${s.repo}')`
    case 'registry':
      return `skill.registry('${s.id}')`
    case 'npm':
      return `skill.npm('${s.spec}')`
    case 'inline':
      return `skill.inline('${s.name}')`
  }
}

/**
 * The names of the harness-placed skills the plan can read without fetching (local and inline
 * ones), layered, with the call that places each; `loadSkills` reads them properly at the attempt.
 */
export function localSkills(
  layers: readonly EnvironmentLayer[],
  root: string,
): Array<{ name: string; call: string }> {
  const out = new Map<string, string>()
  for (const { spec } of layers) {
    for (const s of spec.skills ?? []) {
      if (s.placement !== 'harness') continue
      const call = skillCall(s, root)
      if (s.source === 'inline') out.set(s.name, call)
      if (s.source !== 'local' || !isDir(s.path)) continue
      const dirs = existsSync(join(s.path, 'SKILL.md'))
        ? [s.path]
        : readdirSync(s.path, { withFileTypes: true })
            .filter((e) => e.isDirectory() && existsSync(join(s.path, e.name, 'SKILL.md')))
            .map((e) => join(s.path, e.name))
      for (const d of dirs) {
        const name = skillName(d)
        if (!s.only || s.only.includes(name)) out.set(name, call)
      }
    }
  }
  return [...out].map(([name, call]) => ({ name, call }))
}

/** The package registry a command fetches from at start, or undefined. */
function fetcher(
  command: string,
  args: readonly string[],
): { tool: string; host: string } | undefined {
  const tool = basename(command)
  if (tool === 'npx' || tool === 'bunx') return { tool, host: 'registry.npmjs.org' }
  if (tool === 'uvx') return { tool, host: 'pypi.org' }
  if (tool === 'pipx' && args[0] === 'run') return { tool: 'pipx run', host: 'pypi.org' }
  return undefined
}

/**
 * The plugins' MCP servers and hooks that fetch a package at start (`npx`, `bunx`, `uvx`,
 * `pipx run`): a refusal under a policy that doesn't allow the registry, else notes, since
 * `allowed` is null under `allow-all`.
 */
export function fetchesAtStart(
  plugins: readonly PluginContents[],
  allowed: readonly string[] | null,
): { refusal?: string; notes: string[] } {
  const notes: string[] = []
  for (const p of plugins) {
    const runs = [
      ...Object.entries(p.mcp).flatMap(([name, s]) =>
        s.transport === 'stdio'
          ? [
              {
                what: `the ${p.name} plugin's MCP server "${name}"`,
                command: s.command,
                args: s.args,
              },
            ]
          : [],
      ),
      ...p.hooks.commands.map((c) => {
        const [command = '', ...args] = c.trim().split(/\s+/)
        return { what: `the ${p.name} plugin's hook "${c}"`, command, args }
      }),
    ]
    for (const { what, command, args } of runs) {
      const f = fetcher(command, args)
      if (!f) continue
      const runsIt = `${what} runs ${f.tool}, which fetches from ${f.host} at start`
      if (allowed === null) {
        notes.push(`${runsIt}; add a build that installs it to keep it off the network`)
      } else if (!hostAllowed(allowed, f.host)) {
        return {
          refusal: `${runsIt}: add a build that installs it, or allow the host in egress`,
          notes,
        }
      }
    }
  }
  return { notes }
}
