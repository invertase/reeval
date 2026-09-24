// Worker side of environments: reads skills and files on the host, resolves secrets, and computes
// the digest that goes into fingerprints. Nothing here touches the sandbox.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { run } from '@evalsuite/sandbox-docker/process'
import { isSecret, referencedSecret } from '../environment.ts'
import { sha256 } from '../ids.ts'
import { registerSecret } from '../redact.ts'
import { InfraError } from '../sandbox/types.ts'
import type { Environment, EnvironmentRecord, EnvVars, McpServer, SkillOptions } from '../types.ts'

/** The harness-neutral skill shape the harness adapters take. */
export type HarnessSkill = {
  name: string
  description: string
  content: string
  files: Array<{ path: string; content: string }>
}

export type ResolvedEnvironment = {
  record: EnvironmentRecord
  /** Cached `exec` steps, in order: baked into an image layer. */
  baked: string[]
  /** `exec({ cache: false })` steps, run in each fresh sandbox. */
  perAttempt: string[]
  skills: HarnessSkill[]
  mcp: Record<string, McpServer>
  /** Workspace-relative, or `~/` for the home directory. */
  files: Array<{ path: string; content: string }>
  /** Every variable for the sandbox, secret values included. Never write this anywhere. */
  vars: Record<string, string>
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const GIT_SOURCE = /^(?:https?:\/\/|git@|ssh:\/\/|file:\/\/)|\.git$/

function secretValue(name: string, from: string, where: string): string {
  const value = process.env[from]
  if (!value) {
    const source = from === name ? name : `${name} (from ${from})`
    throw new InfraError(
      `Secret ${source} for ${where} isn't set. Set it in the environment or .env.local.`,
    )
  }
  registerSecret(value)
  return value
}

function resolveVars(env: EnvVars, where: string, secrets: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (isSecret(value)) {
      out[name] = secretValue(name, value.from ?? name, where)
      secrets.push(name)
    } else out[name] = value
  }
  return out
}

function parseSkill(dir: string, source: string): HarnessSkill {
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const front: Record<string, string> = {}
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv?.[1]) front[kv[1]] = (kv[2] ?? '').replace(/^(['"])(.*)\1$/, '$2').trim()
  }
  const name = front.name || basename(dir)
  if (!SKILL_NAME.test(name)) {
    throw new InfraError(`Skill "${name}" in ${source}: the name must be kebab-case`)
  }
  if (!front.description) {
    throw new InfraError(
      `Skill "${name}" in ${source} has no description in its SKILL.md frontmatter`,
    )
  }
  const files: HarnessSkill['files'] = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => path !== 'SKILL.md' && !path.split('/').includes('.git'))
    .sort()
    .map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') }))
  return { name, description: front.description, content: match ? (match[2] ?? '') : text, files }
}

function loadSkills(dir: string, source: string, only?: string[]): HarnessSkill[] {
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
  const skills = dirs.map((d) => parseSkill(d, source))
  if (!only) return skills
  const missing = only.filter((n) => !skills.some((s) => s.name === n))
  if (missing.length) {
    throw new InfraError(
      `skills: ${JSON.stringify(missing)} not found in ${source} (found: ${skills.map((s) => s.name).join(', ')})`,
    )
  }
  return skills.filter((s) => only.includes(s.name))
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

async function resolveSkills(root: string, source: string, options: SkillOptions) {
  if (GIT_SOURCE.test(source)) {
    const { dir, commit } = await cloneSkills(root, source, options.ref)
    const at = options.path ? join(dir, options.path) : dir
    const label = `${source}${options.ref ? `#${options.ref}` : ''}${options.path ? `:${options.path}` : ''}`
    return { skills: loadSkills(at, label, options.skills), source: label, commit }
  }
  const dir = isAbsolute(source) ? source : resolve(root, source)
  return { skills: loadSkills(dir, source, options.skills), source, commit: null }
}

const skillHash = (s: HarnessSkill) => sha256(JSON.stringify(s))

/**
 * Applies the options `env` (merged down the cascade) under the environment's own steps.
 * `where` names the eval for error messages.
 */
export async function resolveEnvironment(
  environment: Environment,
  optionsEnv: EnvVars,
  root: string,
  where: string,
): Promise<ResolvedEnvironment> {
  const secretNames: string[] = []
  const vars = resolveVars(optionsEnv, where, secretNames)
  const baked: string[] = []
  const perAttempt: string[] = []
  const skills: HarnessSkill[] = []
  const skillRecords: EnvironmentRecord['skills'] = []
  const mcp: Record<string, McpServer> = {}
  const files: ResolvedEnvironment['files'] = []
  const envWhere = `environment ${environment.name} (${where})`

  for (const step of environment.steps) {
    switch (step.kind) {
      case 'exec':
        ;(step.cache ? baked : perAttempt).push(step.command)
        break
      case 'skill': {
        const found = await resolveSkills(root, step.source, step.options)
        for (const skill of found.skills) {
          const i = skills.findIndex((s) => s.name === skill.name)
          if (i >= 0) skills.splice(i, 1)
          skills.push(skill)
          skillRecords.push({
            name: skill.name,
            source: found.source,
            commit: found.commit,
            sha256: skillHash(skill),
          })
        }
        break
      }
      case 'mcp': {
        const server = step.server
        if ('url' in server) {
          mcp[step.name] = {
            url: server.url,
            headers: resolveVars(server.headers ?? {}, envWhere, secretNames),
          }
        } else {
          mcp[step.name] = {
            command: server.command,
            args: server.args ?? [],
            env: resolveVars(server.env ?? {}, envWhere, secretNames),
          }
        }
        break
      }
      case 'rules':
        files.push({ path: 'AGENTS.md', content: step.content })
        break
      case 'file': {
        let content: string
        if ('content' in step) content = step.content
        else {
          const from = isAbsolute(step.from) ? step.from : resolve(root, step.from)
          if (!existsSync(from)) throw new InfraError(`${step.from} for ${envWhere} doesn't exist`)
          content = readFileSync(from, 'utf8')
        }
        files.push({ path: step.path, content })
        break
      }
      case 'var':
        vars[step.name] = step.value
        break
      case 'secret':
        vars[step.name] = secretValue(step.name, step.from, envWhere)
        if (!secretNames.includes(step.name)) secretNames.push(step.name)
        break
    }
  }
  for (const command of baked) {
    const secret = referencedSecret(command, secretNames)
    if (secret) {
      throw new InfraError(
        `env.exec(${JSON.stringify(command)}) in ${envWhere} references the secret ${secret}, ` +
          'but cached steps are baked into an image and never see secrets. ' +
          'Pass { cache: false } to run it in each sandbox instead.',
      )
    }
  }
  const uniqueSkills = skillRecords.filter(
    (r, i) => skillRecords.findLastIndex((x) => x.name === r.name) === i,
  )
  const fileRecords = files.map((f) => ({ path: f.path, sha256: sha256(f.content) }))
  const varNames = Object.keys(vars)
    .filter((n) => !secretNames.includes(n))
    .sort()
  const literalVars = Object.fromEntries(varNames.map((n) => [n, vars[n]]))
  const mcpShape = Object.fromEntries(
    Object.entries(mcp).map(([name, s]) =>
      'url' in s
        ? [name, { url: s.url, headers: Object.keys(s.headers ?? {}).sort() }]
        : [name, { command: s.command, args: s.args, env: Object.keys(s.env ?? {}).sort() }],
    ),
  )
  const digest = `sha256:${sha256(
    JSON.stringify({
      baked,
      perAttempt,
      skills: uniqueSkills.map((s) => [s.name, s.sha256]),
      mcp: mcpShape,
      files: fileRecords,
      vars: literalVars,
      secrets: [...secretNames].sort(),
    }),
  )}`
  return {
    record: {
      name: environment.name,
      digest,
      baked,
      perAttempt,
      skills: uniqueSkills,
      mcp: Object.keys(mcp).sort(),
      files: fileRecords,
      vars: varNames,
      secrets: [...secretNames].sort(),
    },
    baked,
    perAttempt,
    skills,
    mcp,
    files,
    vars,
  }
}
