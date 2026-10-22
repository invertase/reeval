// Git workspaces on the host: before any attempt, the CLI fetches each repository the planned
// attempts start from into a cache under `.reeval/cache/git`, resolves its ref to a commit once for
// the run, and exports the tree (or one directory of it) as a tarball the attempts copy in. The
// sandbox never sees the repository, its remote or the credentials that fetched it.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, posix } from 'node:path'
import { RETRY_DELAYS } from '@reeval/sandbox-docker'
import { workspaceLabel } from './environment.ts'
import { git } from './git.ts'
import { sha256 } from './ids.ts'
import { registerSecret } from './redact.ts'
import { PrepareError, type PrepareFailure } from './sandbox/provider.ts'
import type { Cell, GitWorkspace } from './types.ts'

/** What an attempt copies in: the commit the ref resolved to, its tree, and the tarball of it. */
export type PreparedWorkspace = { commit: string; tree: string; tar: string }

/** One attempt's workspace, and the environment that set it, for messages. */
export type WorkspaceUse = { workspace: GitWorkspace; environment: string }

/** A workspace that couldn't be prepared; `usage` when fixing it means changing the eval. */
export class WorkspaceError extends Error {
  override name = 'WorkspaceError'
  readonly usage: boolean
  constructor(message: string, usage: boolean) {
    super(message)
    this.usage = usage
  }
}

export const workspaceKey = (w: GitWorkspace) =>
  JSON.stringify([w.url, w.ref ?? null, w.path ?? null])

const cacheDir = (root: string) => join(root, '.reeval', 'cache', 'git')
const preparedFile = (root: string, runId: string) =>
  join(root, '.reeval', 'cache', 'prepared', `${runId}.git.json`)

const FULL_SHA = /^[0-9a-f]{40}$/

type Failure = 'ref' | 'auth' | 'url' | 'transient' | 'other'

/** What git's stderr says went wrong. */
export function classifyGitError(stderr: string): Failure {
  if (/couldn't find remote ref|not our ref|unadvertised object|invalid refspec/i.test(stderr))
    return 'ref'
  if (
    /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|Access denied|returned error: 40[13]/i.test(
      stderr,
    )
  )
    return 'auth'
  if (
    /Could not resolve host|Connection (?:timed out|refused|reset)|Operation timed out|early EOF|RPC failed|unexpected disconnect|remote end hung up|returned error: 5\d\d|\.lock'?: File exists|Unable to create .*\.lock|could not lock/i.test(
      stderr,
    )
  )
    return 'transient'
  if (
    /Repository not found|does not appear to be a git repository|not a git repository|No such file or directory|Unable to find remote helper|protocol .* is not supported|returned error: 404|not found/i.test(
      stderr,
    )
  )
    return 'url'
  return 'other'
}

const firstLine = (stderr: string) =>
  stderr
    .split('\n')
    .map((l) => l.replace(/^(?:fatal|error): /, '').trim())
    .find(Boolean) ?? 'git failed'

// Batch mode: an SSH key that needs a passphrase or an unknown host key fails instead of prompting.
const GIT_ENV: NodeJS.ProcessEnv = process.env.GIT_SSH_COMMAND
  ? {}
  : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }

async function gitIn(dir: string, args: string[], input?: string, env: NodeJS.ProcessEnv = {}) {
  const r = await git(dir, args, {
    env: { ...GIT_ENV, ...env },
    ...(input !== undefined ? { input } : {}),
  })
  return { ...r, text: r.stdout.toString('utf8').trim() }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fetches, resolves and exports one workspace. `what` names it in messages; `delays` are the
 * waits before each retry of a transient failure.
 */
async function prepareOne(
  root: string,
  w: GitWorkspace,
  what: string,
  delays: readonly number[],
  env: NodeJS.ProcessEnv,
): Promise<PreparedWorkspace> {
  const dir = join(cacheDir(root), 'repos', sha256(w.url).slice(0, 16))
  mkdirSync(dir, { recursive: true })
  const setup = async (args: string[]) => {
    const r = await gitIn(dir, args)
    if (r.code !== 0) {
      throw new WorkspaceError(
        `${what}: couldn't set up its cache in ${dir}: ${firstLine(r.stderr)}`,
        false,
      )
    }
  }
  await setup(['init', '-q', '--bare'])
  await setup(['config', 'remote.origin.url', w.url])
  await setup(['config', 'remote.origin.promisor', 'true'])

  const fetch = async (args: string[], input?: string, config: string[] = []) => {
    for (let i = 0; ; i++) {
      const r = await gitIn(
        dir,
        [...config, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', ...args],
        input,
        env,
      )
      if (r.code === 0) return
      const failure = classifyGitError(r.stderr)
      if (failure === 'transient' && i < delays.length) {
        await sleep(delays[i] ?? 0)
        continue
      }
      throw fetchError(failure, r.stderr, w, what, failure === 'ref' && (await isShallow(w.url)))
    }
  }

  let commit: string | undefined
  if (w.ref && FULL_SHA.test(w.ref)) {
    const known = await gitIn(dir, ['rev-parse', '--verify', '-q', `${w.ref}^{commit}`])
    if (known.code === 0) commit = known.text
  }
  if (!commit) {
    const temp = `refs/reeval/fetch/${process.pid}-${randomBytes(4).toString('hex')}`
    const filter = w.path ? ['--filter=blob:none'] : []
    await fetch(['--depth', '1', ...filter, 'origin', `+${w.ref ?? 'HEAD'}:${temp}`])
    const resolved = await gitIn(dir, ['rev-parse', '--verify', '-q', `${temp}^{commit}`])
    await gitIn(dir, ['update-ref', '-d', temp])
    if (resolved.code !== 0) {
      throw new WorkspaceError(
        `${what}: ref "${w.ref}" isn't a commit (a branch, tag or commit SHA)`,
        true,
      )
    }
    commit = resolved.text
  }
  // Keeps the commit's objects from being pruned, so a pinned SHA reruns offline.
  await gitIn(dir, ['update-ref', `refs/reeval/commits/${commit}`, commit])

  const tree = await treeAt(dir, commit, w, what)
  const tar = join(cacheDir(root), 'trees', `${tree}.tar`)
  if (!existsSync(tar)) {
    const missing = await gitIn(dir, ['rev-list', '--objects', '--missing=print', tree])
    const oids = missing.text
      .split('\n')
      .filter((l) => l.startsWith('?'))
      .map((l) => l.slice(1))
    // A partial fetch left the blobs out: fetch just this tree's, in one batch.
    if (oids.length) {
      await fetch(['--filter=blob:none', '--stdin', 'origin'], `${oids.join('\n')}\n`, [
        '-c',
        'fetch.negotiationAlgorithm=noop',
      ])
    }
    // Git LFS files stay pointers: nothing is fetched beyond the repository itself.
    const archived = await git(
      dir,
      [
        ...['-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=cat'],
        ...['-c', 'filter.lfs.required=false', 'archive', '--format=tar', tree],
      ],
      { env: GIT_ENV },
    )
    if (archived.code !== 0) {
      throw new WorkspaceError(
        `${what}: couldn't export ${tree.slice(0, 12)}: ${firstLine(archived.stderr)}`,
        false,
      )
    }
    mkdirSync(join(cacheDir(root), 'trees'), { recursive: true })
    const partial = `${tar}.${process.pid}-${randomBytes(4).toString('hex')}`
    writeFileSync(partial, archived.stdout)
    renameSync(partial, tar)
  }
  return { commit, tree, tar }
}

/** The tree the workspace is: the commit's, or the directory `path` in it. */
async function treeAt(dir: string, commit: string, w: GitWorkspace, what: string) {
  const at = `${w.ref ? `at ${w.ref} ` : ''}(commit ${commit.slice(0, 7)})`
  if (!w.path) return (await gitIn(dir, ['rev-parse', `${commit}^{tree}`])).text
  const entry = await gitIn(dir, ['ls-tree', commit, '--', w.path])
  const [meta = '', name] = entry.text.split('\t')
  const [, type, oid] = meta.split(' ')
  if (entry.code === 0 && name === w.path && type === 'tree' && oid) return oid
  if (entry.code === 0 && name === w.path) {
    throw new WorkspaceError(`${what} ${at}: "${w.path}" is a file, not a directory`, true)
  }
  let parent = posix.dirname(w.path)
  let list = await gitIn(dir, ['ls-tree', parent === '.' ? commit : `${commit}:${parent}`])
  if (list.code !== 0) {
    parent = '.'
    list = await gitIn(dir, ['ls-tree', commit])
  }
  const names =
    list.code === 0
      ? list.text
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [m = '', n = ''] = l.split('\t')
            return m.split(' ')[1] === 'tree' ? `${n}/` : n
          })
      : []
  const shown = names.slice(0, 12).join(', ') + (names.length > 12 ? ', …' : '')
  const where = parent === '.' ? 'its top level has' : `${parent}/ has`
  throw new WorkspaceError(
    `${what} ${at} has no directory "${w.path}"${names.length ? `; ${where}: ${shown}` : ''}`,
    true,
  )
}

/** A local repository that is a shallow clone, such as a CI checkout at its default depth. */
async function isShallow(url: string) {
  if (!isAbsolute(url)) return false
  const r = await gitIn(url, ['rev-parse', '--is-shallow-repository'])
  return r.code === 0 && r.text === 'true'
}

function fetchError(
  failure: Failure,
  stderr: string,
  w: GitWorkspace,
  what: string,
  shallow = false,
) {
  const line = firstLine(stderr)
  switch (failure) {
    case 'ref': {
      const short =
        w.ref && /^[0-9a-f]{7,39}$/.test(w.ref)
          ? ' Give a commit as its full 40-character SHA.'
          : ''
      const depth = shallow
        ? ` ${w.repo} is a shallow clone, so it may not have that ref: fetch it (git fetch origin ${w.ref ?? 'HEAD'}) or clone the full history (fetch-depth: 0 in actions/checkout).`
        : ''
      return new WorkspaceError(
        `${what}: the repository has no ref "${w.ref ?? 'HEAD'}" (a branch, tag or commit SHA).${short}${depth}`,
        true,
      )
    }
    case 'auth':
      return new WorkspaceError(
        `${what}: isn't readable with this machine's git credentials, or doesn't exist (${line}). reeval fetches the repository on the host, so set up access there (gh auth setup-git, a credential helper or an SSH key); the sandbox never gets the credentials.`,
        true,
      )
    case 'url':
      return new WorkspaceError(
        `${what}: couldn't fetch it (${line}). Check the URL; a private repository also needs this machine's git credentials.`,
        true,
      )
    case 'transient':
      return new WorkspaceError(`${what}: couldn't be fetched (${line})`, false)
    default:
      return new WorkspaceError(`${what}: fetching it failed (${line})`, false)
  }
}

/** A workspace's outcome: what attempts copy in, or the failure every attempt that needs it gets. */
export type WorkspaceOutcome =
  | { ok: true; workspace: GitWorkspace; prepared: PreparedWorkspace }
  | { ok: false; workspace: GitWorkspace; failure: PrepareFailure; label: string; setBy: string[] }

/**
 * The token's header for git, in git's environment rather than its arguments, and only for the
 * repository's own origin. Appended to any `GIT_CONFIG_COUNT` entries already set.
 */
function tokenEnv(url: string, token: string): NodeJS.ProcessEnv {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0
  const header = Buffer.from(`x-access-token:${token}`).toString('base64')
  registerSecret(header)
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${new URL(url).origin}/.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${header}`,
  }
}

/**
 * Prepares every distinct workspace `uses` need, before any attempt, and writes the outcomes for
 * the run's workers. A workspace that fails fails only the attempts that use it.
 */
export async function prepareWorkspaces(
  uses: WorkspaceUse[],
  options: { root: string; runId: string; delays?: readonly number[] },
): Promise<WorkspaceOutcome[]> {
  const distinct = new Map<string, { workspace: GitWorkspace; setBy: string[] }>()
  for (const u of uses) {
    const key = workspaceKey(u.workspace)
    const entry = distinct.get(key) ?? { workspace: u.workspace, setBy: [] }
    const by = `environment ${u.environment}`
    if (!entry.setBy.includes(by)) entry.setBy.push(by)
    distinct.set(key, entry)
  }
  const out = new Map<string, WorkspaceOutcome>()
  // One URL at a time: fetches into the same cache repository would contend for its locks.
  const byUrl = new Map<string, Array<{ workspace: GitWorkspace; setBy: string[] }>>()
  for (const u of distinct.values()) {
    byUrl.set(u.workspace.url, [...(byUrl.get(u.workspace.url) ?? []), u])
  }
  await Promise.all(
    [...byUrl.values()].map(async (list) => {
      for (const { workspace, setBy } of list) {
        const label = workspaceLabel(workspace)
        const what = `Workspace git(${JSON.stringify(label)})`
        const key = workspaceKey(workspace)
        try {
          let env: NodeJS.ProcessEnv = {}
          if (workspace.token) {
            const value = process.env[workspace.token]
            if (!value) {
              throw new WorkspaceError(
                `${what}: its token variable ${workspace.token} isn't set. Set it in the environment or .env.local.`,
                true,
              )
            }
            registerSecret(value)
            env = tokenEnv(workspace.url, value)
          }
          const delays = options.delays ?? RETRY_DELAYS
          const prepared = await prepareOne(options.root, workspace, what, delays, env)
          out.set(key, { ok: true, workspace, prepared })
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error
          const failure: PrepareFailure = {
            class: error.usage ? 'config' : 'transient',
            stage: 'workspace',
            ref: label,
            cause: null,
            log: null,
            message: error.message,
            usage: error.usage,
            setBy,
          }
          out.set(key, { ok: false, workspace, failure, label, setBy })
        }
      }
    }),
  )
  const outcomes = [...distinct.keys()].map((k) => out.get(k) as WorkspaceOutcome)
  if (!outcomes.length) return outcomes
  const file = preparedFile(options.root, options.runId)
  mkdirSync(join(file, '..'), { recursive: true })
  const doc = Object.fromEntries(
    outcomes.map((o) => [
      workspaceKey(o.workspace),
      o.ok ? { prepared: o.prepared } : { failure: o.failure, label: o.label, setBy: o.setBy },
    ]),
  )
  writeFileSync(file, JSON.stringify(doc))
  return outcomes
}

type ArmUse = {
  id: string
  attempt: { cell: Cell; workspace?: GitWorkspace }
}

/**
 * Compare arms whose workspaces are different repositories, refs or paths that resolved to the
 * same tree, one line per arm: such a compare can't see a change to the tree.
 */
export function sameTreeArms(uses: ArmUse[], outcomes: WorkspaceOutcome[]): string[] {
  const trees = new Map<string, string>()
  for (const o of outcomes) if (o.ok) trees.set(workspaceKey(o.workspace), o.prepared.tree)
  const controls = new Map<string, { name: string; workspace: GitWorkspace }>()
  for (const { id, attempt: a } of uses) {
    if (a.cell.role !== 'control' || !a.workspace) continue
    controls.set(`${id}\0${a.cell.harness}`, { name: a.cell.environment, workspace: a.workspace })
  }
  const out = new Set<string>()
  for (const { id, attempt: a } of uses) {
    const control = controls.get(`${id}\0${a.cell.harness}`)
    if (a.cell.role !== 'variant' || !a.workspace || !control) continue
    const [mine, theirs] = [workspaceKey(a.workspace), workspaceKey(control.workspace)]
    const tree = trees.get(mine)
    if (mine === theirs || !tree || tree !== trees.get(theirs)) continue
    const label = (w: GitWorkspace) => `git(${JSON.stringify(workspaceLabel(w))})`
    out.add(
      `warning: compare in ${id}: ${a.cell.environment} and ${control.name} start from the same tree (${tree.slice(0, 12)}): ${label(a.workspace)} and ${label(control.workspace)} resolve to it, so the lift can't show a change to the workspace. Check the refs the arms read.`,
    )
  }
  return [...out]
}

export const removePreparedWorkspaces = (root: string, runId: string) =>
  rmSync(preparedFile(root, runId), { force: true })

type Entry =
  | { prepared: PreparedWorkspace }
  | { failure: PrepareFailure; label: string; setBy: string[] }

const read = new Map<string, Record<string, Entry> | null>()

/**
 * The workspace an attempt copies in, as the CLI prepared it for the run; undefined if it didn't.
 * A workspace that failed throws its failure as a {@link PrepareError}, as a sandbox's does.
 */
export function preparedWorkspace(
  root: string,
  runId: string,
  w: GitWorkspace,
): PreparedWorkspace | undefined {
  const file = preparedFile(root, runId)
  if (!read.has(file)) {
    let doc: Record<string, Entry> | null = null
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'))
    } catch {}
    read.set(file, doc)
  }
  const entry = read.get(file)?.[workspaceKey(w)]
  if (!entry) return undefined
  if ('failure' in entry) {
    throw new PrepareError({
      ...entry.failure,
      message: `${entry.failure.message}\n(the workspace git(${JSON.stringify(entry.label)}), set by ${entry.setBy.join(', ')}, failed to prepare before the run started; every attempt that needs it fails with this)`,
    })
  }
  return entry.prepared
}
