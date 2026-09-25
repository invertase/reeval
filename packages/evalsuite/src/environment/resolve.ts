// Worker side of environments: layers an attempt's environments, reads skills and files on the
// host, resolves secrets, and computes the digest that goes into fingerprints. Nothing here
// touches the sandbox.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { run } from '@evalsuite/sandbox-docker/process'
import { parse as parseYaml } from 'yaml'
import { parseDuration } from '../config.ts'
import {
  type AppliedEnvironment,
  checkImageSecrets,
  DEFAULT_SKILL_EXCLUDE,
  isHostFile,
  isSecret,
  isSecretTemplate,
  parseGitRepo,
  stepCommand,
} from '../environment.ts'
import { sha256 } from '../ids.ts'
import { registerSecret } from '../redact.ts'
import { InfraError } from '../sandbox/types.ts'
import type {
  EnvironmentRecord,
  EnvVars,
  HostFile,
  McpServer,
  Secret,
  SecretTemplate,
  SkillPlacement,
  SkillSource,
} from '../types.ts'

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
  /** Baked into a cached image layer, in order. */
  image: Array<{ run: string; timeoutMs?: number }>
  /** Run in each fresh sandbox, in order, before the agent starts. */
  setup: ResolvedStep[]
  /** Handed to the harness adapter. */
  skills: HarnessSkill[]
  /** Written into the harness's repo skill directory. */
  workspaceSkills: HarnessSkill[]
  mcp: Record<string, ResolvedMcpServer>
  /** Workspace-relative, or `~/` for the home directory. */
  files: Array<{ path: string; content: string }>
  /** The container's variables, secret values included. Never write this anywhere. */
  vars: Record<string, string>
  /** `to: 'checks'` secrets: only for `t.exec` and setup steps. */
  checkVars: Record<string, string>
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_SETUP_TIMEOUT = '5m'

type Secrets = { names: string[]; checks: string[]; unset: string[] }

function hostValue(name: string, secret: Secret, where: string, secrets: Secrets) {
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
  return value
}

function template(value: SecretTemplate, where: string): string {
  return value.template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name]
    if (!v) throw new InfraError(`secret.template needs ${name} for ${where}, and it isn't set`)
    registerSecret(v)
    return v
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
    throw new InfraError(`${where}: the SKILL.md frontmatter must be a YAML mapping`)
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
    throw new InfraError(`Skill "${name}" in ${source}: the name must be kebab-case`)
  }
  if (!description) {
    throw new InfraError(
      `Skill "${name}" in ${source} has no description in its SKILL.md frontmatter`,
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
    throw new InfraError(`Skill source ${source} isn't a directory`)
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
      const dir = join(root, '.es', 'cache', 'skills', `${sha256(key).slice(0, 16)}-${process.pid}`)
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
        '.es',
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
      const label = `${s.repo}${s.ref ? `#${s.ref}` : ''}${s.path ? `:${s.path}` : ''}`
      return {
        skills: loadSkills(s.path ? join(dir, s.path) : dir, label, s.only, s.exclude),
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
      const label = `npm:${s.spec}:${s.path}`
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

const skillHash = (s: HarnessSkill) => sha256(JSON.stringify(s))

const readHostFile = (f: HostFile, where: string) => {
  if (!existsSync(f.path)) throw new InfraError(`${f.path} for ${where} doesn't exist`)
  return readFileSync(f.path, 'utf8')
}

/**
 * Layers the environment (root first; a later layer wins on shared keys, and each such key is
 * an override), over the options `env` merged down the cascade. `where` names the attempt, and
 * `rulesFile` is where the harness's agent reads `rules` from.
 */
export async function resolveEnvironment(
  environment: AppliedEnvironment,
  optionsEnv: EnvVars,
  root: string,
  where: string,
  rulesFile = 'AGENTS.md',
): Promise<ResolvedEnvironment> {
  const envWhere = `environment ${environment.name} (${where})`
  checkImageSecrets(environment.name, environment.layers, optionsEnv, InfraError)
  const overrides = new Set<string>()
  const env: EnvVars = { ...optionsEnv }
  const files = new Map<string, string | HostFile>()
  const mcp = new Map<string, McpServer>()
  const skills = new Map<
    string,
    LoadedSkill & { placement: SkillPlacement; source: string; commit: string | null }
  >()
  let rules: string | HostFile | undefined
  const image: ResolvedEnvironment['image'] = []
  const setup: ResolvedStep[] = []
  const seen = { env: new Set<string>(), files: new Set<string>(), mcp: new Set<string>() }

  for (const { spec } of environment.layers) {
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
    for (const step of spec.image ?? []) {
      image.push(
        typeof step === 'string'
          ? { run: step }
          : { run: step.run, ...(step.timeout ? { timeoutMs: parseDuration(step.timeout) } : {}) },
      )
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
        })
      }
    }
  }

  const secrets: Secrets = { names: [], checks: [], unset: [] }
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
  const secretOf = (value: string | Secret | SecretTemplate, key: string): string | undefined => {
    if (typeof value === 'string') return value
    if (isSecretTemplate(value)) return template(value, envWhere)
    return hostValue(key, value, envWhere, secrets)
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
      for (const [k, v] of Object.entries(s.headers)) {
        const r = secretOf(v, k)
        if (r !== undefined) h[k] = r
      }
      resolvedMcp[name] = { transport: s.transport, url: s.url, headers: h }
    }
  }

  const fileList = [...files].map(([path, v]) => ({
    path,
    content: isHostFile(v) ? readHostFile(v, envWhere) : v,
  }))
  const rulesContent =
    rules === undefined ? undefined : isHostFile(rules) ? readHostFile(rules, envWhere) : rules
  const skillList = [...skills.values()]
  const skillRecords = skillList.map(({ skill, placement, source, commit, excluded }) => ({
    name: skill.name,
    source,
    commit,
    sha256: skillHash(skill),
    placement,
    excluded,
  }))
  const fileRecords = fileList.map((f) => ({ path: f.path, sha256: sha256(f.content) }))
  const rulesRecord =
    rulesContent === undefined ? undefined : { path: rulesFile, sha256: sha256(rulesContent) }
  if (rulesContent !== undefined) fileList.push({ path: rulesFile, content: rulesContent })
  const secretNames = [...new Set([...secrets.names, ...secrets.checks])].sort()
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
  const digest = `sha256:${sha256(
    JSON.stringify({
      image,
      setup,
      skills: skillRecords.map((s) => [s.name, s.sha256, s.placement]),
      mcp: mcpShape,
      files: fileRecords,
      rules: rulesRecord?.sha256,
      vars: literalVars,
      secrets: secretNames,
      checks: [...secrets.checks].sort(),
      unset: [...secrets.unset].sort(),
    }),
  )}`
  return {
    record: {
      name: environment.name,
      parent: environment.parent,
      overrides: [...overrides],
      digest,
      image: image.map(stepCommand),
      setup: setup.map(stepCommand),
      skills: skillRecords,
      mcp: Object.keys(resolvedMcp).sort(),
      files: rulesRecord ? [...fileRecords, rulesRecord] : fileRecords,
      vars: varNames,
      secrets: secretNames,
      unset: [...secrets.unset].sort(),
    },
    image,
    setup,
    skills: skillList.filter((s) => s.placement === 'harness').map((s) => s.skill),
    workspaceSkills: skillList.filter((s) => s.placement === 'workspace').map((s) => s.skill),
    mcp: resolvedMcp,
    files: fileList,
    vars,
    checkVars,
  }
}

/** A skill as a `SKILL.md` file plus its other files, for writing into a directory. */
export function skillFiles(skill: HarnessSkill): Array<{ path: string; content: string }> {
  const front = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n`
  return [{ path: 'SKILL.md', content: `${front}${skill.content}` }, ...skill.files]
}
