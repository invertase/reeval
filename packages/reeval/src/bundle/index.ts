// `reeval bundle` and `reeval run --bundle`: a project's run as one portable archive, and running it
// from one. Both take the plan from a child `reeval run --dry-run --json`, whose `inputs` name every
// host file the run reads, so what goes in the archive and what's checked on the way out is the
// same list.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { gunzipSync, gzipSync } from 'node:zlib'
import { run as runProcess } from '@reeval/sandbox-docker/process'
import type { Flags } from '../cli-spec.ts'
import { requireConfig } from '../config.ts'
import { UsageError } from '../errors.ts'
import { git, repoTop } from '../git.ts'
import { gitInfo } from '../history/provenance.ts'
import { PreflightInfraError } from '../preflight.ts'
import { DIST_DIR, PACKAGE_VERSION, reevalCommand } from '../root.ts'
import { savedFilters } from '../resume.ts'
import { extractTar, readTar, type TarEntry, writeTar } from '../tarball.ts'
import { withoutBom } from '../text.ts'
import { NewerSchemaError, readableBundleManifest } from '../view/record.ts'
import type { BundleArgs, BundleEnvFile, BundleFile, BundleManifest } from './types.ts'

const MANIFEST = 'manifest.json'

/** The placeholder for the bundle root's absolute path in the plan a manifest keeps. */
const ROOT = '<root>'

/** Never in a bundle, wherever an input directory holds them. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.reeval'])

const isEnvFile = (name: string) => name === '.env' || name.startsWith('.env.')

/** The package manager configuration an install from the lockfile reads, beside it. */
const INSTALL_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.yarnrc.yml',
  '.yarnrc',
  'bunfig.toml',
  'pyproject.toml',
  '.python-version',
  '.nvmrc',
  '.node-version',
]

/** A line of an `.npmrc` that holds a registry credential. */
const NPMRC_CREDENTIAL = /(?:_auth|_authToken|_password|token)\s*=/i

/** Each lockfile and the install that reproduces it exactly. */
const INSTALLS: Array<{ lockfile: string; command: (dir: string) => [string, ...string[]] }> = [
  { lockfile: 'pnpm-lock.yaml', command: () => ['pnpm', 'install', '--frozen-lockfile'] },
  { lockfile: 'package-lock.json', command: () => ['npm', 'ci'] },
  { lockfile: 'npm-shrinkwrap.json', command: () => ['npm', 'ci'] },
  {
    lockfile: 'yarn.lock',
    command: (dir) =>
      existsSync(join(dir, '.yarnrc.yml'))
        ? ['yarn', 'install', '--immutable']
        : ['yarn', 'install', '--frozen-lockfile'],
  },
  { lockfile: 'bun.lock', command: () => ['bun', 'install', '--frozen-lockfile'] },
  { lockfile: 'bun.lockb', command: () => ['bun', 'install', '--frozen-lockfile'] },
  { lockfile: 'uv.lock', command: () => ['uv', 'sync', '--frozen'] },
]

type PlanInput = { path: string; kind: string; evals?: string[] }
type PlanDoc = Record<string, unknown> & {
  profile?: { name: string } | null
  inputs?: PlanInput[]
  secrets?: string[]
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const posix = (path: string) => path.split(sep).join('/')
const within = (dir: string, path: string) => path === dir || path.startsWith(dir + sep)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The `reeval run` arguments that plan `args`, for a dry run of the config at `config`. */
function runArgs(args: Pick<BundleArgs, 'filters' | 'profile' | 'tags' | 'traits' | 'runs'>) {
  return [
    'run',
    ...args.filters,
    ...(args.profile ? ['--profile', args.profile] : []),
    ...args.tags.flatMap((t) => ['--tag', t]),
    ...args.traits.flatMap((t) => ['--trait', t]),
    ...(args.runs ? ['--runs', args.runs] : []),
  ]
}

/**
 * The plan document a child `reeval run --dry-run --json` prints in `cwd`, or the code it exited
 * with when it refused: its errors reach the terminal as they are.
 */
async function dryRun(
  cwd: string,
  args: string[],
  config: string,
): Promise<{ plan: PlanDoc } | { code: number }> {
  const [cmd, ...rest] = reevalCommand(join(DIST_DIR, 'cli.js'), [
    ...args,
    '--dry-run',
    '--json',
    '--config',
    config,
  ])
  const child = spawn(cmd, rest, {
    cwd,
    env: { ...process.env, REEVAL_PRICES: process.env.REEVAL_PRICES ?? 'none' },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    out += d
  })
  const code = await new Promise<number | null>((done, fail) => {
    child.on('error', fail)
    child.on('close', done)
  })
  if (code !== 0) return { code: code ?? 3 }
  return { plan: JSON.parse(out) as PlanDoc }
}

/** `value` with the absolute path `root` written as {@link ROOT} in every string. */
function rooted<T>(value: T, root: string): T {
  const escape = (s: string) => JSON.stringify(s).slice(1, -1)
  const json = JSON.stringify(value)
    .split(escape(root + sep))
    .join(`${ROOT}/`)
    .split(`"${escape(root)}"`)
    .join(`"${ROOT}"`)
  return JSON.parse(json) as T
}

/** The `.env` file's variable names. */
async function envNames(path: string): Promise<string[]> {
  const text = withoutBom(await readFile(path, 'utf8'))
  return Object.keys(parseEnv(text)).sort()
}

/** Every regular file under `dir`, skipping {@link SKIP_DIRS} and handing `.env` files to `env`. */
async function walk(dir: string, env: (path: string) => Promise<void>): Promise<string[]> {
  const out: string[] = []
  for (const name of (await readdir(dir)).sort()) {
    const full = join(dir, name)
    const info = await stat(full).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...(await walk(full, env)))
    } else if (info.isFile()) {
      if (isEnvFile(name)) await env(full)
      else out.push(full)
    }
  }
  return out
}

/**
 * The bundle root: the project directory, or its git repository's top when an input (a lockfile,
 * a shared skill) is outside the project but in the repository. An input outside both can't be
 * placed in a clean checkout, so it's refused.
 */
async function bundleRoot(project: string, inputs: string[]): Promise<string> {
  const outside = inputs.filter((p) => !within(project, p))
  if (!outside.length) return project
  const top = await repoTop(project)
  const top_ = top ? await realpath(top) : null
  const away = outside.filter((p) => !top_ || !within(top_, p))
  if (away.length) {
    throw new UsageError(
      `The run reads ${plural(away.length, 'file')} outside ${top_ ? 'its git repository' : 'the project'}, which a bundle can't place in another checkout: ${away.slice(0, 5).join(', ')}${away.length > 5 ? ', …' : ''}. Move ${away.length === 1 ? 'it' : 'them'} into the ${top_ ? 'repository' : 'project'}.`,
    )
  }
  return top_ as string
}

/** `reeval bundle`: plans as `reeval run --dry-run` does and writes the run's inputs as one archive. */
export async function bundleCommand(
  flags: Flags,
  filters: string[],
  configPath: string | undefined,
  argv: string[],
  out: (line: string) => void,
): Promise<number> {
  const config = await realpath(requireConfig(configPath))
  const project = dirname(config)
  const given = {
    filters: savedFilters(project, filters),
    ...(flags.profile ? { profile: flags.profile } : {}),
    tags: flags.tag ?? [],
    traits: flags.trait ?? [],
    ...(flags.runs ? { runs: flags.runs } : {}),
  }
  const planned = await dryRun(project, runArgs(given), config)
  if ('code' in planned) return planned.code
  const { plan } = planned
  const inputs = (plan.inputs ?? []).map((i) => ({
    ...i,
    abs: isAbsolute(i.path) ? i.path : join(project, ...i.path.split('/')),
  }))
  const workspaces = inputs.filter((i) => i.kind === 'workspace')
  if (workspaces.length) {
    throw new UsageError(
      `A bundle can't carry a local git() workspace, whose history reeval fetches: ${workspaces.map((w) => w.path).join(', ')}. Point git() at a remote repository to bundle the run.`,
    )
  }
  const root = await bundleRoot(
    project,
    inputs.map((i) => i.abs),
  )
  const envFiles = new Map<string, BundleEnvFile>()
  const addEnv = async (path: string) => {
    const rel = posix(relative(root, path))
    if (!envFiles.has(rel)) envFiles.set(rel, { path: rel, variables: await envNames(path) })
  }
  const kinds = new Map<string, string>()
  const notes: string[] = []
  for (const input of inputs) {
    if (input.kind === 'env-file') {
      await addEnv(input.abs)
      continue
    }
    const info = await stat(input.abs).catch(() => null)
    if (!info) continue
    const files = info.isDirectory() ? await walk(input.abs, addEnv) : [input.abs]
    for (const file of files) if (!kinds.has(file)) kinds.set(file, input.kind)
  }
  for (let dir = project; within(root, dir); dir = dirname(dir)) {
    for (const name of INSTALL_FILES) {
      const file = join(dir, name)
      if (kinds.has(file) || !(await stat(file).catch(() => null))?.isFile()) continue
      if (name === '.npmrc' && NPMRC_CREDENTIAL.test(await readFile(file, 'utf8'))) {
        notes.push(
          `left out ${posix(relative(root, file))}: it holds a registry credential; give the install its own`,
        )
        continue
      }
      kinds.set(file, 'install')
    }
    if (dir === root) break
  }
  const files: BundleFile[] = []
  const entries: TarEntry[] = []
  for (const file of [...kinds.keys()].sort()) {
    const path = posix(relative(root, file))
    if (path === MANIFEST) {
      throw new UsageError(
        `The run reads ${MANIFEST} at the bundle root, where the bundle keeps its own manifest. Move or rename it to bundle the run.`,
      )
    }
    const [data, info] = await Promise.all([readFile(file), lstat(file)])
    files.push({ path, kind: kinds.get(file) as string, sha256: sha256(data), size: data.length })
    entries.push({
      type: 'file',
      path,
      mode: info.mode & 0o777,
      mtime: Math.floor(info.mtimeMs / 1000),
      data,
    })
  }
  const git = await gitInfo(project)
  const { inputs: _inputs, secrets = [], ...rest } = plan
  const manifest: BundleManifest = {
    schemaVersion: 1,
    reeval: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    args: {
      argv,
      ...given,
      ...(plan.profile?.name ? { profile: plan.profile.name } : {}),
    },
    project: posix(relative(root, project)),
    config: posix(relative(root, config)),
    git: git ? { commit: git.sha, dirty: git.dirty } : null,
    plan: rooted({ ...rest, inputs: plan.inputs ?? [], secrets }, root),
    files,
    envFiles: [...envFiles.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    secrets,
  }
  const now = Math.floor(Date.now() / 1000)
  const manifestEntry: TarEntry = {
    type: 'file',
    path: MANIFEST,
    mode: 0o644,
    mtime: now,
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  }
  const target = resolve(flags.out ?? `${basename(project) || 'reeval'}.bundle.tar.gz`)
  const archive = gzipSync(writeTar([manifestEntry, ...entries]))
  await writeFile(target, archive)
  const bytes = files.reduce((n, f) => n + f.size, 0)
  out(
    `Bundled ${plural(files.length, 'file')} (${bytes} bytes) for ${plural(Number((plan.totals as { attempts?: number } | undefined)?.attempts ?? 0), 'attempt')} into ${relative(process.cwd(), target) || target}`,
  )
  if (secrets.length) out(`  needs: ${secrets.join(', ')}`)
  for (const env of manifest.envFiles) {
    out(
      `  left out ${env.path}${env.variables.length ? ` (${env.variables.join(', ')})` : ''}: set ${env.variables.length === 1 ? 'it' : 'them'} where the bundle runs`,
    )
  }
  if (git?.dirty) out('  the project has uncommitted changes; the bundle carries them')
  for (const note of notes) out(`  ${note}`)
  return 0
}

/** Each difference between two plan documents, by JSON path, at most `limit`. */
function differences(a: unknown, b: unknown, at = '', found: string[] = [], limit = 8): string[] {
  if (found.length >= limit) return found
  if (JSON.stringify(a) === JSON.stringify(b)) return found
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((v, i) => differences(v, b[i], `${at}[${i}]`, found, limit))
  } else if (isObj(a) && isObj(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      differences(a[key], b[key], at ? `${at}.${key}` : key, found, limit)
    }
  } else {
    const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 80))
    found.push(`${at || 'the plan'}: ${show(a)} → ${show(b)}`)
  }
  return found
}

/** Keys of the plan that depend on the machine or its history, not on the bundle's files. */
const MACHINE_KEYS = new Set(['runId', 'estimateMs', 'cost', 'concurrency', 'stages', 'fits'])

/** The parts of a plan document a bundle must reproduce. */
function comparable(plan: Record<string, unknown>) {
  const strip = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(strip)
      : typeof v === 'object' && v !== null
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !MACHINE_KEYS.has(k))
              .map(([k, x]) => [k, strip(x)]),
          )
        : v
  const { profile, totals, evals, excluded, images, secrets } = plan
  return strip({ profile, totals, evals, excluded, images, secrets }) as Record<string, unknown>
}

export type OpenedBundle = {
  /** Set when the bundle's dry run refused, with its exit code; nothing else is. */
  exit?: number
  /** Where the bundle was extracted; the run's `.reeval/` lands in its project directory. */
  dir: string
  project: string
  config: string
  manifest: BundleManifest
}

/**
 * `reeval run --bundle`: extracts the bundle to a new temporary directory, checks every file
 * against its manifest, installs from its lockfiles and dry-runs it there, and refuses (exit 2,
 * naming each file) when a file is missing or differs or the plan isn't the manifest's.
 */
export async function openBundle(
  file: string,
  log: (line: string) => void,
): Promise<OpenedBundle> {
  let entries: TarEntry[]
  try {
    entries = readTar(gunzipSync(await readFile(file)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(`No bundle at ${file}`)
    }
    throw new UsageError(`${file} isn't a reeval bundle (a .tar.gz from reeval bundle)`)
  }
  const manifestEntry = entries.find((e) => e.type === 'file' && e.path === MANIFEST)
  if (manifestEntry?.type !== 'file') {
    throw new UsageError(`${file} has no ${MANIFEST}, so it isn't a reeval bundle`)
  }
  let manifest: BundleManifest
  try {
    manifest = readableBundleManifest(JSON.parse(manifestEntry.data.toString('utf8')), file)
  } catch (error) {
    if (error instanceof NewerSchemaError) throw new UsageError(error.message)
    throw new UsageError(`${file}'s ${MANIFEST} isn't valid JSON`)
  }
  if (manifest.reeval !== PACKAGE_VERSION) {
    log(
      `reeval: ${file} was bundled by reeval ${manifest.reeval}; this is ${PACKAGE_VERSION}, whose plan may differ`,
    )
  }
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reeval-bundle-')))
  try {
    const files = entries.filter((e) => e.path !== MANIFEST)
    await extractTar(files, dir)
    const listed = new Map(manifest.files.map((f) => [f.path, f]))
    const problems: string[] = []
    for (const f of manifest.files) {
      const data = await readFile(join(dir, ...f.path.split('/'))).catch(() => null)
      if (!data) problems.push(`missing: ${f.path}`)
      else if (sha256(data) !== f.sha256) problems.push(`differs: ${f.path}`)
    }
    for (const e of files) {
      if (e.type === 'file' && !listed.has(e.path)) problems.push(`not in the manifest: ${e.path}`)
    }
    const project = join(dir, ...manifest.project.split('/').filter(Boolean))
    for (const input of (manifest.plan as PlanDoc).inputs ?? []) {
      if (input.kind === 'env-file' || isAbsolute(input.path)) continue
      const path = input.path.startsWith(`${ROOT}/`)
        ? join(dir, input.path.slice(ROOT.length + 1))
        : join(project, input.path)
      const shown = posix(relative(dir, path))
      if (!existsSync(path) && !problems.includes(`missing: ${shown}`)) {
        problems.push(`missing: ${shown}`)
      }
    }
    if (problems.length) {
      throw new UsageError(
        `${file} doesn't match its manifest, so nothing ran:\n${problems.map((p) => `  ${p}`).join('\n')}`,
      )
    }
    const config = join(dir, ...manifest.config.split('/'))
    // reeval finds a monorepo's root lockfile at the repository's top, and an extracted copy
    // under some other checkout mustn't find that one's: the bundle root is a repository of its
    // own, with no commits, as a fresh clone's top is.
    await git(dir, ['init', '-q']).catch(() => {})
    await install(manifest, dir, log)
    const planned = await dryRun(project, runArgs(manifest.args), config)
    if ('code' in planned) {
      log(`reeval: ${file}'s dry run in ${project} failed, so nothing ran`)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      return { exit: planned.code, dir, project, config, manifest }
    }
    const { plan } = planned
    const differs = planDifferences(manifest, rooted(plan, dir))
    if (differs.length) {
      throw new UsageError(
        `${file} doesn't plan here as it did where it was bundled, so nothing ran:\n${differs.map((p) => `  ${p}`).join('\n')}`,
      )
    }
    return { dir, project, config, manifest }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** What differs between the manifest's plan and `plan`, the same run's dry run from the bundle. */
function planDifferences(manifest: BundleManifest, plan: PlanDoc): string[] {
  const out: string[] = []
  const project = manifest.project ? `${manifest.project}/` : ''
  const inputs = (doc: { inputs?: PlanInput[] }) =>
    new Map(
      (doc.inputs ?? []).filter((i) => i.kind !== 'env-file').map((i) => [i.path, i.kind] as const),
    )
  const before = inputs(manifest.plan as PlanDoc)
  const now = inputs(plan)
  const inBundle = (path: string) =>
    path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : `${project}${path}`
  for (const [path, kind] of now) {
    if (before.has(path)) continue
    out.push(
      isAbsolute(path)
        ? `the run reads ${path} on this machine, outside the bundle`
        : `the run reads ${inBundle(path)} (${kind}), which the bundle doesn't have`,
    )
  }
  for (const [path] of before) {
    if (!now.has(path)) out.push(`the bundle has ${inBundle(path)}, which the run no longer reads`)
  }
  out.push(...differences(comparable(manifest.plan), comparable(plan)).map((d) => `plan: ${d}`))
  return out
}

/** Installs from each lockfile in the bundle, in its directory, the way its lockfile pins. */
async function install(
  manifest: BundleManifest,
  dir: string,
  log: (line: string) => void,
): Promise<void> {
  for (const f of manifest.files) {
    if (f.kind !== 'lockfile') continue
    const how = INSTALLS.find((i) => i.lockfile === basename(f.path))
    if (!how) continue
    const at = join(dir, ...dirname(f.path).split('/').filter((p) => p !== '.'))
    const [cmd, ...args] = how.command(at)
    log(`reeval: installing from ${f.path}: ${cmd} ${args.join(' ')}`)
    const result = await runProcess(cmd, args, { cwd: at }).catch((error: Error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new UsageError(
          `The bundle installs from ${f.path} with ${cmd}, which isn't on this machine's PATH. Install ${cmd}, then run it again.`,
        )
      }
      throw error
    })
    if (result.exitCode !== 0) {
      const said = `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-20).join('\n')
      throw new PreflightInfraError(
        `${cmd} ${args.join(' ')} failed (exit ${result.exitCode}) installing from ${f.path}, so nothing ran:\n${said}`,
      )
    }
  }
}
