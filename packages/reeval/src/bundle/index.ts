// `reeval bundle` and `reeval run --bundle`: a project's run as one portable archive, and running it
// from one. Both take the plan from a child `reeval run --dry-run --json`, whose `inputs` name every
// host file the run reads, so what goes in the archive and what's checked on the way out is the
// same list.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix as posixPath,
  relative,
  resolve,
  sep,
} from 'node:path'
import { parseEnv } from 'node:util'
import { gunzipSync, gzipSync } from 'node:zlib'
import { run as runProcess } from '@reeval/sandbox-docker/process'
import { z } from 'zod'
import type { Flags } from '../cli-spec.ts'
import { requireConfig } from '../config.ts'
import { UsageError } from '../errors.ts'
import { git, repoTop } from '../git.ts'
import { gitInfo } from '../history/provenance.ts'
import { findingLines, scanText } from '../history/secret-scan.ts'
import { PreflightInfraError } from '../preflight.ts'
import { savedFilters } from '../resume.ts'
import { DIST_DIR, PACKAGE_VERSION, reevalCommand } from '../root.ts'
import { extractTar, readTar, safeTarPath, type TarEntry, writeTar } from '../tarball.ts'
import { withoutBom } from '../text.ts'
import { NewerSchemaError, readableBundleManifest } from '../view/record.ts'
import type { BundleArgs, BundleEnvFile, BundleFile, BundleLink, BundleManifest } from './types.ts'

const MANIFEST = 'manifest.json'

/** The placeholder for the bundle root's absolute path in the plan a manifest keeps. */
const ROOT = '<root>'

/** Never in a bundle: a path through one is the install's, git's or reeval's own. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.reeval'])
const throughSkipped = (rel: string) => rel.split('/').some((p) => SKIP_DIRS.has(p))

/** Files a bundle never carries, only names with their variables: dotenv files and `.envrc`. */
const isEnvFile = (name: string) => name === '.env' || name.startsWith('.env.') || name === '.envrc'

/** Input kinds whose local path is a git repository reeval clones, history and all. */
const REPOSITORY_KINDS = new Set(['workspace', 'skill', 'plugin', 'marketplace'])

/**
 * Package manager settings that hold a registry credential, by file name: a value that isn't a
 * `${VAR}` (or bun's `$VAR`) reference. The match's first group is the setting.
 */
const REGISTRY_CREDENTIALS: Record<string, RegExp> = {
  '.npmrc': /^[ \t]*(?:\S*:)?(_auth|_authToken|_password)[ \t]*=[ \t]*(?!["']?\$\{)\S/m,
  '.yarnrc':
    /^[ \t]*["']?(?:\S*:)?(_auth|_authToken|_password)["']?[ \t]*[ =][ \t]*(?!["']?\$\{)\S/m,
  '.yarnrc.yml': /^[ \t]*(npmAuthToken|npmAuthIdent|npmPassword)[ \t]*:[ \t]*(?!["']?\$\{)[^\s#]/m,
  'bunfig.toml': /(?:^|[{,])[ \t]*(token|password)[ \t]*=[ \t]*["'](?!\$)/m,
}

/** The shortest variable value a bundled file is checked for: shorter ones match by chance. */
const MIN_SECRET = 8

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

type PlanInput = { path: string; kind: string; evals?: string[]; symlinkTo?: string }
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
  const inJson = (s: string) => JSON.stringify(s).slice(1, -1)
  const json = JSON.stringify(value)
    .split(inJson(root + sep))
    .join(`${ROOT}/`)
    .split(`"${inJson(root)}"`)
    .join(`"${ROOT}"`)
  return JSON.parse(json) as T
}

type Collected = {
  /** Each file the bundle carries, by its path under the root (links not resolved), and its kind. */
  kinds: Map<string, string>
  /** Each skill's or plugin's symbolic link, by its path, and its target relative to its folder. */
  links: Map<string, string>
  envFiles: Map<string, BundleEnvFile>
  /** Each loaded `.env` variable's value, by the variable: a bundled file mustn't hold one. */
  values: Map<string, string>
  /** Links whose target is outside the bundle root, relative to it. */
  outside: string[]
  /** `.env` files the run copies into the sandbox, which a bundle can't carry, and their kinds. */
  carried: Array<{ path: string; kind: string }>
}

/**
 * The files under `root` that `inputs` name: a directory's walked, each link resolved and kept
 * only when its target is under `root`, never through {@link SKIP_DIRS}, and `.env` files listed
 * by their variables instead.
 */
export async function collect(
  inputs: Array<{ abs: string; kind: string; symlinkTo?: string }>,
  root: string,
) {
  const c: Collected = {
    kinds: new Map(),
    links: new Map(),
    envFiles: new Map(),
    values: new Map(),
    outside: [],
    carried: [],
  }
  const rel = (path: string) => posix(relative(root, path))
  const listEnv = async (path: string) => {
    const at = rel(path)
    if (c.envFiles.has(at)) return
    const parsed = parseEnv(withoutBom(await readFile(path, 'utf8')))
    c.envFiles.set(at, { path: at, variables: Object.keys(parsed).sort() })
    for (const [name, value] of Object.entries(parsed)) if (value) c.values.set(name, value)
  }
  /** `path` and what it resolves to, or null when it's dangling or resolves outside `root`. */
  const resolved = async (path: string) => {
    const target = await realpath(path).catch(() => null)
    if (target && !within(root, target)) c.outside.push(rel(path))
    return target && within(root, target) ? target : null
  }
  const walk = async (dir: string, kind: string, ancestors: string[]) => {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name)
      const info = await lstat(full).catch(() => null)
      if (!info || SKIP_DIRS.has(name)) continue
      const target = info.isSymbolicLink() ? await resolved(full) : full
      if (!target) continue
      const real = info.isSymbolicLink() ? await stat(target) : info
      if (real.isDirectory()) {
        // A link back to a directory being walked would walk it forever.
        if (!ancestors.includes(target)) await walk(full, kind, [...ancestors, target])
      } else if (real.isFile()) {
        if (isEnvFile(name)) await listEnv(full)
        else if (!c.kinds.has(full)) c.kinds.set(full, kind)
      }
    }
  }
  for (const input of inputs) {
    if (throughSkipped(rel(input.abs))) continue
    if (input.kind === 'env-file') {
      await listEnv(input.abs)
      continue
    }
    const link = await lstat(input.abs).catch(() => null)
    if (!link) continue
    const target = await resolved(input.abs)
    if (!target) continue
    if (input.symlinkTo !== undefined && link.isSymbolicLink()) {
      // The plan lists the target's files too, so only the link itself is carried here.
      const from = await realpath(dirname(input.abs))
      c.links.set(input.abs, posix(relative(from, target)) || '.')
      continue
    }
    const info = await stat(target)
    if (info.isDirectory()) await walk(input.abs, input.kind, [target])
    else if (!info.isFile() || c.kinds.has(input.abs)) continue
    else if (isEnvFile(basename(input.abs)) || isEnvFile(basename(target))) {
      c.carried.push({ path: rel(input.abs), kind: input.kind })
    } else c.kinds.set(input.abs, input.kind)
  }
  return c
}

/**
 * Why each file in `files` can't be bundled: a secret-looking value (the history's secret scan),
 * a package manager setting with a registry credential in it, or the value of a variable in
 * `values` (a loaded `.env`'s, and the host's for each of the run's secrets). Each value is
 * reported once a file, by the variables that hold it, and not again by the scan.
 */
function leaks(
  files: Array<{ path: string; data: Buffer }>,
  values: Map<string, string>,
): string[] {
  const byValue = new Map<string, string[]>()
  for (const [name, value] of values) byValue.set(value, [...(byValue.get(value) ?? []), name])
  const out: string[] = []
  for (const { path, data } of files) {
    const held = [...byValue].filter(([value]) => data.includes(value))
    for (const [, names] of held) out.push(`${path}: holds the value of ${names.join(' and ')}`)
    if (data.subarray(0, 8000).includes(0)) continue
    let text = data.toString('utf8')
    for (const [value] of held) text = text.replaceAll(value, '*'.repeat(value.length))
    out.push(...findingLines(path, scanText(path, text)))
    const setting = REGISTRY_CREDENTIALS[basename(path)]?.exec(text)?.[1]
    if (setting) {
      out.push(`${path}: ${setting} holds a registry credential; read it from a variable instead`)
    }
  }
  return out
}

/** How to keep a `.env` file of `kind` out of what the run copies into the sandbox. */
function leaveOut(kind: string): string {
  if (kind === 'file') {
    return "leave it out of the environment's files (directory()'s glob: ['!.env*']) and give the sandbox its variables with env"
  }
  if (kind === 'skill') return "leave it out of the skill with skill.local()'s exclude"
  if (kind === 'plugin' || kind === 'plugin-build') return "move it out of the plugin's folder"
  if (kind === 'docker-context' || kind === 'dockerfile') {
    return "list it in the build context's .dockerignore"
  }
  if (kind === 'npm') return "list it in the package's .npmignore"
  return 'move it out of what the run reads'
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
  const repositories: string[] = []
  for (const i of inputs) {
    if (i.symlinkTo !== undefined || !REPOSITORY_KINDS.has(i.kind)) continue
    if ((await stat(i.abs).catch(() => null))?.isDirectory()) {
      repositories.push(`${i.path} (${i.kind})`)
    }
  }
  if (repositories.length) {
    throw new UsageError(
      `A bundle can't carry a local git repository, whose history reeval clones: ${repositories.join(', ')}. Point it at a remote repository to bundle the run.`,
    )
  }
  const root = await bundleRoot(
    project,
    inputs.filter((i) => i.kind !== 'env-file').map((i) => i.abs),
  )
  const installFiles: Array<{ abs: string; kind: string }> = []
  for (let dir = project; within(root, dir); dir = dirname(dir)) {
    for (const name of INSTALL_FILES) installFiles.push({ abs: join(dir, name), kind: 'install' })
    if (dir === root) break
  }
  const { kinds, links, envFiles, values, outside, carried } = await collect(
    [...inputs, ...installFiles],
    root,
  )
  if (outside.length) {
    throw new UsageError(
      `The run reads through ${plural(outside.length, 'link')} to files outside the bundle root, which a bundle can't carry: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}. Copy what ${outside.length === 1 ? 'it links' : 'they link'} to into the project.`,
    )
  }
  if (carried.length) {
    throw new UsageError(
      `The run copies ${carried.length === 1 ? 'a .env file' : '.env files'} into the sandbox, and a bundle never carries one:\n${carried.map((c) => `  ${c.path} (${c.kind}): ${leaveOut(c.kind)}`).join('\n')}`,
    )
  }
  const { inputs: _inputs, secrets = [], ...rest } = plan
  const watched = new Map<string, string>()
  for (const [name, value] of values) {
    if (value.length >= MIN_SECRET && (secrets.includes(name) || !/^[a-z]+$/.test(value))) {
      watched.set(name, value)
    }
  }
  for (const name of secrets) {
    const value = process.env[name]
    if (value && value.length >= MIN_SECRET) watched.set(name, value)
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
    const [data, info] = await Promise.all([readFile(file), stat(file)])
    files.push({ path, kind: kinds.get(file) as string, sha256: sha256(data), size: data.length })
    entries.push({
      type: 'file',
      path,
      mode: info.mode & 0o111 ? 0o755 : 0o644,
      mtime: Math.floor(info.mtimeMs / 1000),
      data,
    })
  }
  const bundleLinks: BundleLink[] = [...links]
    .map(([file, target]) => ({ path: posix(relative(root, file)), target }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  const linkEntries: TarEntry[] = bundleLinks.map((l) => ({
    type: 'symlink',
    path: l.path,
    mode: 0o777,
    mtime: Math.floor(Date.now() / 1000),
    target: l.target,
  }))
  const git = await gitInfo(project)
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
    ...(bundleLinks.length ? { links: bundleLinks } : {}),
    envFiles: [...envFiles.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    secrets,
  }
  const manifestEntry: TarEntry = {
    type: 'file',
    path: MANIFEST,
    mode: 0o644,
    mtime: Math.floor(Date.now() / 1000),
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  }
  const found = leaks(
    [manifestEntry, ...entries].map((e) => ({ path: e.path, data: (e as { data: Buffer }).data })),
    watched,
  )
  if (found.length) {
    throw new UsageError(
      `The bundle would carry secrets, so nothing was written:\n${found.map((l) => `  ${l}`).join('\n')}\nMove each out of the files the run reads, or read it from a variable.`,
    )
  }
  const target = resolve(flags.out ?? `${basename(project) || 'reeval'}.bundle.tar.gz`)
  const archive = gzipSync(writeTar([manifestEntry, ...entries, ...linkEntries]))
  await writeFile(target, archive)
  const bytes = files.reduce((n, f) => n + f.size, 0)
  out(
    `Bundled ${plural(files.length, 'file')}${bundleLinks.length ? ` and ${plural(bundleLinks.length, 'link')}` : ''} (${bytes} bytes) for ${plural(Number((plan.totals as { attempts?: number } | undefined)?.attempts ?? 0), 'attempt')} into ${relative(process.cwd(), target) || target}`,
  )
  if (secrets.length) out(`  needs: ${secrets.join(', ')}`)
  for (const env of manifest.envFiles) {
    out(
      `  left out ${env.path}${env.variables.length ? ` (${env.variables.join(', ')})` : ''}: set ${env.variables.length === 1 ? 'it' : 'them'} where the bundle runs`,
    )
  }
  if (git?.dirty) out('  the project has uncommitted changes; the bundle carries them')
  return 0
}

/** Each difference between two plan documents, by JSON path, at most `limit`. */
function differences(a: unknown, b: unknown, at = '', found: string[] = [], limit = 8): string[] {
  if (found.length >= limit) return found
  if (JSON.stringify(a) === JSON.stringify(b)) return found
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (const [i, v] of a.entries()) differences(v, b[i], `${at}[${i}]`, found, limit)
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

/** A path inside the bundle, as `safeTarPath` writes it: relative, `/`-separated, no `..`. */
const bundlePath = z
  .string()
  .refine((p) => safeTarPath(p) === p && p !== MANIFEST, 'must be a path inside the bundle')

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  reeval: z.string(),
  createdAt: z.string(),
  args: z.object({
    argv: z.array(z.string()),
    filters: z.array(z.string()),
    profile: z.string().optional(),
    tags: z.array(z.string()),
    traits: z.array(z.string()),
    runs: z.string().optional(),
  }),
  project: z.union([z.literal(''), bundlePath]),
  config: bundlePath,
  git: z.object({ commit: z.string(), dirty: z.boolean() }).nullable(),
  plan: z.record(z.string(), z.unknown()),
  files: z.array(
    z.object({
      path: bundlePath,
      kind: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 in hex'),
      size: z.number().int().nonnegative(),
    }),
  ),
  links: z
    .array(
      z
        .object({ path: bundlePath, target: z.string() })
        .refine(
          (l) =>
            !l.target.startsWith('/') &&
            !!safeTarPath(posixPath.join(posixPath.dirname(l.path), l.target)),
          { message: 'must link to a path inside the bundle', path: ['target'] },
        ),
    )
    .optional(),
  envFiles: z.array(z.object({ path: z.string(), variables: z.array(z.string()) })),
  secrets: z.array(z.string()),
}) satisfies z.ZodType<BundleManifest>

/** `value` as a manifest, or a refusal naming the first few fields that aren't one. */
function validManifest(value: unknown, file: string): BundleManifest {
  const parsed = manifestSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const lines = parsed.error.issues.slice(0, 5).map((issue) => {
    const at = issue.path
      .map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i ? '.' : ''}${String(p)}`))
      .join('')
    return `  ${at || 'the manifest'}: ${issue.message}`
  })
  throw new UsageError(`${file}'s ${MANIFEST} isn't a bundle manifest:\n${lines.join('\n')}`)
}

/** The prefix of each directory `run --bundle` extracts into, followed by its process id. */
const EXTRACT_PREFIX = 'reeval-bundle-'

/** reeval's exit code after SIGINT. */
const EXIT_INTERRUPTED = 130

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * `reeval clean --bundles`: removes every directory `run --bundle` extracted into whose process
 * has ended, and returns their paths.
 */
export async function removeExtractedBundles(): Promise<string[]> {
  const removed: string[] = []
  for (const name of await readdir(tmpdir()).catch(() => [])) {
    const pid = new RegExp(`^${EXTRACT_PREFIX}(\\d+)-`).exec(name)?.[1]
    if (!pid || alive(Number(pid))) continue
    const dir = join(tmpdir(), name)
    await rm(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  return removed
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
export async function openBundle(file: string, log: (line: string) => void): Promise<OpenedBundle> {
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
  let read: unknown
  try {
    read = JSON.parse(manifestEntry.data.toString('utf8'))
  } catch {
    throw new UsageError(`${file}'s ${MANIFEST} isn't valid JSON`)
  }
  let manifest: BundleManifest
  try {
    manifest = validManifest(readableBundleManifest(read as BundleManifest, file), file)
  } catch (error) {
    if (error instanceof NewerSchemaError) throw new UsageError(error.message)
    throw error
  }
  if (manifest.reeval !== PACKAGE_VERSION) {
    log(
      `reeval: ${file} was bundled by reeval ${manifest.reeval}; this is ${PACKAGE_VERSION}, whose plan may differ`,
    )
  }
  const inBundle = (path: string) =>
    path.startsWith(`${ROOT}/`)
      ? safeTarPath(path.slice(ROOT.length + 1))
      : safeTarPath(manifest.project ? `${manifest.project}/${path}` : path)
  const planInputs = (manifest.plan as PlanDoc).inputs ?? []
  const atPath = (kind: (i: PlanInput) => boolean) =>
    new Set(planInputs.filter(kind).flatMap((i) => inBundle(i.path) ?? []))
  const planLinks = atPath((i) => i.symlinkTo !== undefined)
  const envPaths = atPath((i) => i.kind === 'env-file')
  const listed = new Map(manifest.files.map((f) => [f.path, f]))
  const links = new Map((manifest.links ?? []).map((l) => [l.path, l.target]))
  const problems: string[] = []
  for (const [path, target] of links) {
    if (envPaths.has(path) || isEnvFile(basename(path))) {
      problems.push(`a link where the run loads a .env file: ${path}`)
    } else if (!planLinks.has(path)) {
      problems.push(`a link its plan doesn't list: ${path}`)
    } else if (throughLink(path, target, links)) {
      problems.push(`a link through another link: ${path} → ${target}`)
    }
  }
  const files: Array<TarEntry & { type: 'file' }> = []
  const linked: Array<TarEntry & { type: 'symlink' }> = []
  for (const e of entries) {
    if (e === manifestEntry) continue
    if (e.type === 'symlink' && links.has(e.path) && !linked.some((x) => x.path === e.path)) {
      if (links.get(e.path) === e.target) linked.push(e)
      else problems.push(`differs: ${e.path}, a link to ${e.target}`)
      continue
    }
    if (e.type !== 'file') {
      problems.push(
        `not a regular file or a listed link: ${e.path} (a ${e.type === 'dir' ? 'directory' : 'link'})`,
      )
      continue
    }
    const f = listed.get(e.path)
    if (!f) problems.push(`not in the manifest: ${e.path}`)
    else if (files.some((x) => x.path === e.path)) problems.push(`in the archive twice: ${e.path}`)
    else {
      if (sha256(e.data) !== f.sha256) problems.push(`differs: ${f.path}`)
      files.push({ ...e, mode: e.mode & 0o111 ? 0o755 : 0o644 })
    }
  }
  for (const f of manifest.files) {
    if (!files.some((e) => e.path === f.path)) problems.push(`missing: ${f.path}`)
  }
  for (const [path] of links) {
    if (!linked.some((e) => e.path === path)) problems.push(`missing: ${path}`)
  }
  for (const input of planInputs) {
    if (input.kind === 'env-file' || isAbsolute(input.path)) continue
    const path = inBundle(input.path)
    if (!path) problems.push(`outside the bundle: ${input.path}`)
    else if (throughSkipped(path) || isEnvFile(basename(path))) continue
    else if (!listed.has(path) && !links.has(path) && !problems.includes(`missing: ${path}`)) {
      problems.push(`missing: ${path}`)
    }
  }
  if (problems.length) {
    throw new UsageError(
      `${file} doesn't match its manifest, so nothing ran:\n${problems.map((p) => `  ${p}`).join('\n')}`,
    )
  }
  const dir = await realpath(await mkdtemp(join(tmpdir(), `${EXTRACT_PREFIX}${process.pid}-`)))
  // Until the run starts, the copy is only the bundle's: an interrupt leaves nothing behind.
  const interrupted = () => {
    rmSync(dir, { recursive: true, force: true })
    process.exit(EXIT_INTERRUPTED)
  }
  process.once('SIGINT', interrupted)
  try {
    // Links go last, so no file is written through one.
    const skipped = await extractTar([...files, ...linked], dir)
    const escapes: string[] = []
    for (const l of linked) {
      const real = await realpath(join(dir, ...l.path.split('/'))).catch(() => null)
      if (!real) escapes.push(`  a link to nothing: ${l.path} → ${l.target}`)
      else if (!within(dir, real))
        escapes.push(`  a link out of the bundle: ${l.path} → ${l.target}`)
    }
    if (skipped.length || escapes.length) {
      throw new UsageError(
        `${file} doesn't match its manifest, so nothing ran:\n${[...skipped.map((p) => `  not extracted: ${p}`), ...escapes].join('\n')}`,
      )
    }
    const project = join(dir, ...manifest.project.split('/').filter(Boolean))
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
  } finally {
    process.off('SIGINT', interrupted)
  }
}

/**
 * Whether `target`, read from the link at `path` one segment at a time, passes through another
 * of `links`: the lexical check can't see where that one leads, so a chain could leave the bundle.
 */
function throughLink(path: string, target: string, links: Map<string, string>): boolean {
  const at = path.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '..') at.pop()
    else if (part && part !== '.') {
      at.push(part)
      if (links.has(at.join('/'))) return true
    }
  }
  return false
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
    const at = join(
      dir,
      ...dirname(f.path)
        .split('/')
        .filter((p) => p !== '.'),
    )
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
