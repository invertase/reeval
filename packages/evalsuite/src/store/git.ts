import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { GitError, git, gitText } from '../git.ts'
import { sha256 } from '../ids.ts'
import { stripCredentials } from '../redact.ts'
import {
  type CommitChange,
  type CommitReport,
  ImmutableFileError,
  type ResultsStore,
  type StoreReader,
} from './types.ts'

export type GitBranchStoreOptions = {
  /** Orphan branch holding the results (default `es-results`). */
  branch?: string
  /** A remote name of the project repo (default `origin`), or a URL or path. */
  remote?: string
  /** Project root: resolves remote names, relative paths and the cache (default: cwd). */
  root?: string
  /** Bare cache repo (default `<root>/.es/cache/git/<hash>.git`). */
  cacheDir?: string
  /** Partial-clone filter: big transcripts are fetched only when read (default `blob:limit=128k`). */
  filter?: string
  /** Publish attempts before giving up when other publishers keep winning (default 8). */
  maxAttempts?: number
}

export type GitBranchStore = ResultsStore & {
  /** The commit the store's view is at, or null before the branch exists. */
  tip(): Promise<string | null>
}

const TIP = 'refs/es/tip'
const REJECTED =
  /non-fast-forward|fetch first|\[rejected\]|failed to push|stale info|cannot lock ref|reference already exists/i

const looksLikeLocation = (remote: string) =>
  remote.includes('/') || remote.includes(':') || remote.startsWith('.')

type Resolved = { cache: string; env: NodeJS.ProcessEnv; url: string }

export function gitBranchStore(options: GitBranchStoreOptions = {}): GitBranchStore {
  const branch = options.branch ?? 'es-results'
  const remote = options.remote ?? 'origin'
  const root = resolve(options.root ?? process.cwd())
  const filter = options.filter ?? 'blob:limit=128k'
  const maxAttempts = options.maxAttempts ?? 8
  let resolved: Promise<Resolved> | undefined

  // No I/O until first use, so loading a config never needs git or the network.
  const ready = () => {
    resolved ??= resolveRemote().catch((error) => {
      resolved = undefined
      throw error
    })
    return resolved
  }

  async function resolveRemote(): Promise<Resolved> {
    let url: string
    if (looksLikeLocation(remote)) {
      url =
        /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ||
        /^[^/]+@[^/]+:/.test(remote) ||
        isAbsolute(remote)
          ? remote
          : resolve(root, remote)
    } else {
      const r = await git(root, ['remote', 'get-url', remote])
      if (r.code !== 0) {
        throw new GitError(
          `No git remote named "${remote}" in ${root}. Pass a URL or path instead.`,
        )
      }
      url = r.stdout.toString('utf8').trim()
    }
    // Auth that actions/checkout configures for the project (http.<url>.extraheader), passed
    // through the environment so it never appears in argv or error messages.
    const env: NodeJS.ProcessEnv = {}
    const headers = await git(root, ['config', '--get-regexp', '^http\\..*extraheader$'])
    const pairs =
      headers.code === 0 ? headers.stdout.toString('utf8').split('\n').filter(Boolean) : []
    pairs.forEach((line, i) => {
      const space = line.indexOf(' ')
      env[`GIT_CONFIG_KEY_${i}`] = line.slice(0, space)
      env[`GIT_CONFIG_VALUE_${i}`] = line.slice(space + 1)
    })
    env.GIT_CONFIG_COUNT = String(pairs.length)
    const cache =
      options.cacheDir ??
      join(root, '.es', 'cache', 'git', `${sha256(`${url}\0${branch}`).slice(0, 12)}.git`)
    if (!existsSync(join(cache, 'HEAD'))) {
      await mkdir(cache, { recursive: true })
      await gitText(cache, ['init', '--bare', '-q'])
    }
    // Rewritten each time so a changed remote URL takes effect.
    for (const [key, value] of [
      ['remote.origin.url', url],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialclonefilter', filter],
      ['core.logAllRefUpdates', 'false'],
      ['gc.auto', '0'],
    ] as const) {
      await gitText(cache, ['config', key, value])
    }
    const ident = await git(cache, ['var', 'GIT_COMMITTER_IDENT'], { env })
    if (ident.code !== 0) {
      Object.assign(env, {
        GIT_AUTHOR_NAME: 'evalsuite',
        GIT_AUTHOR_EMAIL: 'evalsuite@localhost',
        GIT_COMMITTER_NAME: 'evalsuite',
        GIT_COMMITTER_EMAIL: 'evalsuite@localhost',
      })
    }
    return { cache, env, url }
  }

  const run = async (args: string[], input?: string | Uint8Array) => {
    const { cache, env } = await ready()
    return git(cache, args, { env, input })
  }
  const text = async (args: string[], input?: string) => {
    const { cache, env } = await ready()
    return gitText(cache, args, { env, input })
  }

  async function tip(): Promise<string | null> {
    const r = await run(['rev-parse', '--verify', '-q', `${TIP}^{commit}`])
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null
  }

  async function fetch(): Promise<void> {
    const heads = await run(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
    if (heads.code !== 0)
      throw new GitError(`Can't reach the results remote: ${heads.stderr.trim()}`)
    if (!heads.stdout.toString('utf8').trim()) {
      await run(['update-ref', '-d', TIP])
      return
    }
    const r = await run([
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      `--filter=${filter}`,
      'origin',
      `+refs/heads/${branch}:${TIP}`,
    ])
    if (r.code !== 0) throw new GitError(`Fetching ${branch} failed: ${r.stderr.trim()}`)
  }

  /** `path → blob oid` at `commit`, for the given paths or prefixes. */
  async function blobs(commit: string, paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (paths.length === 0) return out
    const r = await run(['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...paths])
    if (r.code !== 0) throw new GitError(`git ls-tree failed: ${r.stderr.trim()}`)
    for (const line of r.stdout.toString('utf8').split('\0')) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const [, type, oid] = line.slice(0, tab).split(' ')
      if (type === 'blob' && oid) out.set(line.slice(tab + 1), oid)
    }
    return out
  }

  async function listAt(commit: string | null, prefix: string): Promise<string[]> {
    if (!commit) return []
    const clean = prefix.replace(/\/+$/, '')
    return [...(await blobs(commit, [clean || '.'])).keys()].sort()
  }

  async function getAt(commit: string | null, path: string): Promise<Uint8Array | null> {
    if (!commit) return null
    const r = await run(['cat-file', 'blob', `${commit}:${path}`])
    return r.code === 0 ? r.stdout : null
  }

  async function writeBlob(bytes: Uint8Array): Promise<string> {
    const r = await run(['hash-object', '-w', '--stdin'], bytes)
    if (r.code !== 0) throw new GitError(`git hash-object failed: ${r.stderr.trim()}`)
    return r.stdout.toString('utf8').trim()
  }

  async function attempt(
    change: CommitChange,
    oids: Map<string, string>,
  ): Promise<CommitReport | 'retry'> {
    await fetch()
    const base = await tip()
    const created: string[] = []
    const existing: string[] = []
    const present = base
      ? await blobs(base, [...new Set([...change.files.keys()].map(runPrefix))])
      : new Map()
    for (const [path, oid] of oids) {
      const current = present.get(path)
      if (current === undefined) created.push(path)
      else if (current === oid) existing.push(path)
      else throw new ImmutableFileError(path)
    }

    const { cache } = await ready()
    const indexFile = join(cache, `es-index-${process.pid}-${randomBytes(4).toString('hex')}`)
    const withIndex = async (args: string[], input?: string) => {
      const { env } = await ready()
      return gitText(cache, args, { env: { ...env, GIT_INDEX_FILE: indexFile }, input })
    }
    try {
      await withIndex(base ? ['read-tree', base] : ['read-tree', '--empty'])
      const pending = new Map(created.map((p) => [p, change.files.get(p) as Uint8Array]))
      const view: StoreReader = {
        async list(prefix) {
          const clean = prefix.replace(/\/+$/, '')
          const mine = [...pending.keys()].filter(
            (p) => !clean || p === clean || p.startsWith(`${clean}/`),
          )
          return [...new Set([...(await listAt(base, prefix)), ...mine])].sort()
        },
        async get(path) {
          return pending.get(path) ?? getAt(base, path)
        },
      }
      const derived = await change.derive(view)
      const entries = created.map((p) => `100644 blob ${oids.get(p)}\t${p}`)
      for (const [path, bytes] of derived)
        entries.push(`100644 blob ${await writeBlob(bytes)}\t${path}`)
      if (entries.length)
        await withIndex(['update-index', '-z', '--index-info'], `${entries.join('\0')}\0`)
      const tree = await withIndex(['write-tree'])
      if (base && tree === (await text(['rev-parse', `${base}^{tree}`]))) {
        return { created: [], existing, attempts: 0, changed: false }
      }
      const commit = await text([
        'commit-tree',
        tree,
        ...(base ? ['-p', base] : []),
        '-m',
        change.message,
      ])
      const push = await run([
        'push',
        '-q',
        '--no-verify',
        'origin',
        `${commit}:refs/heads/${branch}`,
      ])
      if (push.code === 0) {
        await run(['update-ref', TIP, commit])
        return { created, existing, attempts: 0, changed: true }
      }
      if (REJECTED.test(push.stderr)) return 'retry'
      throw new GitError(`Pushing ${branch} failed: ${push.stderr.trim()}`)
    } finally {
      await rm(indexFile, { force: true })
      await rm(`${indexFile}.lock`, { force: true })
    }
  }

  return {
    describe: () => ({ kind: 'git-branch', branch, remote: stripCredentials(remote) }),
    tip,
    refresh: fetch,
    list: async (prefix) => listAt(await tip(), prefix),
    get: async (path) => getAt(await tip(), path),
    async commit(change) {
      const oids = new Map<string, string>()
      for (const [path, bytes] of change.files) oids.set(path, await writeBlob(bytes))
      for (let n = 1; n <= maxAttempts; n++) {
        const result = await attempt(change, oids)
        if (result !== 'retry') return { ...result, attempts: n }
        await sleep((100 + Math.random() * 300) * n)
      }
      throw new GitError(
        `Gave up publishing to ${branch} after ${maxAttempts} attempts: other publishers kept pushing first. Rerunning is safe.`,
      )
    },
  }
}

/** Lists a whole run directory at once rather than every file separately. */
function runPrefix(path: string): string {
  return /^runs\/\d{4}\/\d{2}\/[^/]+/.exec(path)?.[0] ?? path
}
