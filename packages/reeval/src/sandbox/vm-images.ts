// The images `boat()` and `daytona()` keep as the provider's snapshots, named
// `<prefix>-img-<first 12 hex of the key>`: what this machine last used (in `vm-images.json` in
// reeval's host cache, since Boat records no last use), what an account holds under a
// prefix, and which of the project's environments each one is for. `reeval image list` and
// `clean` read them; preflight notes each one it uses.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { UsageError } from '../errors.ts'
import { sandboxId } from '../options.ts'
import { cacheDir } from '../root.ts'
import type { BoatSandboxDescriptor, DaytonaSandboxDescriptor, PluginSource } from '../types.ts'
import { harnessBake } from './harness-install.ts'
import type { ImageUse } from './images.ts'
import type { SandboxProvider } from './provider.ts'
import { recipeOf } from './recipe.ts'
import { InfraError } from './types.ts'

export type VmImageProvider = 'boat' | 'daytona'

type VmSandbox = BoatSandboxDescriptor | DaytonaSandboxDescriptor

/** One account's snapshots under one prefix: the first sandbox the evals name it with. */
export type VmAccount = { provider: VmImageProvider; sandbox: VmSandbox }

/** One snapshot under an account's `<prefix>-img-`, as the provider reports it. */
export type VmSnapshot = {
  provider: VmImageProvider
  /** The host variable with the account's key. */
  account: string
  prefix: string
  name: string
  /** Boat's `saving` / `ready` / `failed`, or Daytona's state. */
  status: string
  sizeBytes: number | null
  createdAt: number | null
  /** When the provider says it last started a sandbox from it; Boat doesn't. */
  lastUsedAt: number | null
}

/** One image to build into a snapshot: a VM sandbox's recipe on one harness. */
export type VmImageTarget = {
  id: string
  provider: VmImageProvider
  sandbox: VmSandbox
  harness: ImageUse['harness']
  plugins: readonly PluginSource[]
  /** The evals that use it. */
  ids: string[]
}

const isVm = (kind: string): kind is VmImageProvider => kind === 'boat' || kind === 'daytona'

/** Where each prefix's images start, so nothing else in the account is listed or deleted. */
export const imagePrefix = (prefix: string) => `${prefix}-img-`

const isImageName = (prefix: string, name: string) =>
  name.startsWith(imagePrefix(prefix)) &&
  /^[0-9a-f]{12}$/.test(name.slice(imagePrefix(prefix).length))

/** The distinct accounts and prefixes the planned VM sandboxes use, recipe or not. */
export function vmAccounts(uses: ImageUse[]): VmAccount[] {
  const accounts = new Map<string, VmAccount>()
  for (const { sandbox } of uses) {
    if (!isVm(sandbox.kind)) continue
    const s = sandbox as VmSandbox
    const key = JSON.stringify([s.kind, s.apiKey.from, s.prefix])
    if (!accounts.has(key)) accounts.set(key, { provider: s.kind, sandbox: s })
  }
  return [...accounts.values()]
}

/** The distinct VM sandbox recipes and harnesses the evals plan, in first-use order. */
export function vmImageTargets(uses: ImageUse[]): VmImageTarget[] {
  const targets = new Map<string, VmImageTarget>()
  for (const { id, sandbox, harness, plugins = [] } of uses) {
    if (!isVm(sandbox.kind)) continue
    const s = sandbox as VmSandbox
    const recipe = recipeOf(s)
    if (!recipe) continue
    const baked = harnessBake(harness)?.label ?? harness.kind
    const size = s.kind === 'daytona' ? (s.size ?? 'medium') : null
    const key = JSON.stringify([s.kind, s.apiKey.from, s.prefix, size, recipe, baked, plugins])
    const target = targets.get(key) ?? {
      id: `${sandboxId(s)} · ${baked}`,
      provider: s.kind,
      sandbox: s,
      harness,
      plugins: s.kind === 'boat' ? plugins : [],
      ids: [],
    }
    if (!target.ids.includes(id)) target.ids.push(id)
    targets.set(key, target)
  }
  return [...targets.values()]
}

/** The snapshot `target`'s image is saved under, which names what its bases are now. */
export async function vmImageName(target: VmImageTarget, root: string): Promise<string> {
  if (target.provider === 'boat') {
    const { snapshotName, vmImageKey } = await import('./boat-images.ts')
    const recipe = recipeOf(target.sandbox)
    if (!recipe) throw new Error(`${target.id} has no image recipe`)
    const { key } = await vmImageKey(recipe, target.harness, { root, plugins: target.plugins })
    return snapshotName(target.sandbox.prefix, key)
  }
  const { daytonaImage } = await import('./daytona-image.ts')
  const image = await daytonaImage(target.sandbox as DaytonaSandboxDescriptor, target.harness)
  if (!image) throw new Error(`${target.id} has no image recipe`)
  return image.name
}

type CacheEntry = {
  provider: VmImageProvider
  account: string
  name: string
  key: string
  lastUsedAt: number
  builtAt?: number
}

const cacheFile = () => join(cacheDir(), 'vm-images.json')
const entryKey = (e: Pick<CacheEntry, 'provider' | 'account' | 'name'>) =>
  `${e.provider}\0${e.account}\0${e.name}`

/** What this machine used, by provider, account and snapshot. */
export function readVmImageCache(): Map<string, CacheEntry> {
  try {
    const doc = JSON.parse(readFileSync(cacheFile(), 'utf8')) as { images?: CacheEntry[] }
    return new Map((doc.images ?? []).map((e) => [entryKey(e), e]))
  } catch {
    return new Map()
  }
}

function writeCache(entries: Map<string, CacheEntry>): void {
  const file = cacheFile()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ images: [...entries.values()] }, null, 2)}\n`)
  renameSync(temp, file)
}

/** Notes that this machine used (or built) a snapshot now. */
export function noteVmImage(image: {
  provider: VmImageProvider
  account: string
  name: string
  key: string
  built: boolean
}): void {
  const entries = readVmImageCache()
  const now = Date.now()
  const before = entries.get(entryKey(image))
  const builtAt = image.built ? now : before?.builtAt
  entries.set(entryKey(image), {
    provider: image.provider,
    account: image.account,
    name: image.name,
    key: image.key,
    lastUsedAt: now,
    ...(builtAt !== undefined && { builtAt }),
  })
  try {
    writeCache(entries)
  } catch {
    // A cache that can't be written costs `clean` its last-used dates, not the run.
  }
}

function forget(gone: VmSnapshot[]): void {
  const entries = readVmImageCache()
  for (const s of gone) entries.delete(entryKey(s))
  try {
    writeCache(entries)
  } catch {}
}

/** When this machine last used `snapshot`, or else when the provider says one did. */
export function lastUsed(snapshot: VmSnapshot, cache: Map<string, CacheEntry>): number | null {
  const here = cache.get(entryKey(snapshot))?.lastUsedAt ?? null
  if (here === null) return snapshot.lastUsedAt
  return snapshot.lastUsedAt === null ? here : Math.max(here, snapshot.lastUsedAt)
}

const time = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const t = new Date(value as string | Date).getTime()
  return Number.isFinite(t) && t > 0 ? t : null
}

type BoatListing = {
  listSavedSnapshots(): Promise<{
    snapshots: Array<{ name: string; status: string; sizeBytes?: number; createdAt?: unknown }>
  }>
  deleteSavedSnapshot(p: { name: string }): Promise<unknown>
}

/** The snapshots under `account`'s image prefix. */
export async function listVmSnapshots(account: VmAccount, root: string): Promise<VmSnapshot[]> {
  const { sandbox } = account
  const base = { provider: account.provider, account: sandbox.apiKey.from, prefix: sandbox.prefix }
  if (account.provider === 'boat') {
    const boat = await import('./boat.ts')
    const api = (await boat.boatClient(sandbox, root)) as unknown as BoatListing
    const { snapshots } = await api.listSavedSnapshots().catch(async (error: unknown) => {
      throw new InfraError(`Boat didn't list its saved snapshots: ${await boat.boatError(error)}`)
    })
    return snapshots
      .filter((s) => isImageName(sandbox.prefix, s.name))
      .map((s) => ({
        ...base,
        name: s.name,
        status: s.status,
        sizeBytes: s.sizeBytes ?? null,
        createdAt: time(s.createdAt),
        lastUsedAt: null,
      }))
  }
  const { daytonaClient } = await import('./daytona.ts')
  const api = await daytonaClient(sandbox, root)
  const found: VmSnapshot[] = []
  for (let page = 1; ; page++) {
    const listed = await api.snapshot.list({ page, limit: 100 }).catch((error: unknown) => {
      throw new InfraError(`Daytona didn't list its snapshots: ${(error as Error).message}`)
    })
    for (const s of listed.items) {
      if (!isImageName(sandbox.prefix, s.name)) continue
      found.push({
        ...base,
        name: s.name,
        status: s.state ?? 'unknown',
        // Daytona reports a snapshot's size in GB.
        sizeBytes: typeof s.size === 'number' ? Math.round(s.size * 1024 ** 3) : null,
        createdAt: time(s.createdAt),
        lastUsedAt: time(s.lastUsedAt),
      })
    }
    if (!listed.items.length || page >= (listed.totalPages ?? page)) return found
  }
}

/** Deletes `snapshot` from its account; one that's already gone is fine. */
export async function deleteVmSnapshot(
  account: VmAccount,
  snapshot: VmSnapshot,
  root: string,
): Promise<void> {
  if (account.provider === 'boat') {
    const boat = await import('./boat.ts')
    const api = (await boat.boatClient(account.sandbox, root)) as unknown as BoatListing
    await api.deleteSavedSnapshot({ name: snapshot.name }).catch(async (error: unknown) => {
      if ((error as { response?: Response }).response?.status === 404) return
      throw new InfraError(
        `Boat didn't delete snapshot ${snapshot.name}: ${await boat.boatError(error)}`,
      )
    })
  } else {
    const { daytonaClient } = await import('./daytona.ts')
    const api = await daytonaClient(account.sandbox, root)
    const statusOf = (error: unknown) => (error as { statusCode?: number }).statusCode
    try {
      await api.snapshot.delete(await api.snapshot.get(snapshot.name))
    } catch (error) {
      if (statusOf(error) !== 404) {
        throw new InfraError(
          `Daytona didn't delete snapshot ${snapshot.name}: ${(error as Error).message}`,
        )
      }
    }
  }
  forget([snapshot])
}

/** How recently a use keeps a snapshot from `reeval image clean`, whatever its flags. */
export const RECENT_MS = 60 * 60_000

/** How long `reeval image clean` keeps an unused snapshot without `--older-than` or `--all`. */
export const DEFAULT_OLDER_THAN_MS = 14 * 86_400_000

/**
 * The states a snapshot rests in, Boat's and Daytona's: `clean` keeps one in any other, which may
 * be one being saved, built or removed now.
 */
const SETTLED = new Set(['ready', 'failed', 'active', 'inactive', 'error', 'build_failed'])

export type CleanChoice = { snapshot: VmSnapshot; keep: string | null }

/**
 * Which snapshots `reeval image clean` deletes, and why it keeps each other one: one an
 * environment of the project uses (unless `all`), one used in the last hour (by this machine or, as Daytona reports, any), one
 * still being saved or built, and one used more recently than `olderThanMs`.
 */
export function cleanChoices(
  snapshots: VmSnapshot[],
  o: {
    cache: Map<string, CacheEntry>
    usedBy: Map<string, string[]>
    now: number
    olderThanMs?: number
    all?: boolean
  },
): CleanChoice[] {
  return snapshots.map((snapshot) => {
    const used = lastUsed(snapshot, o.cache)
    const by = o.usedBy.get(snapshot.name) ?? []
    const since = used ?? snapshot.createdAt
    let keep: string | null = null
    if (used !== null && o.now - used < RECENT_MS) keep = 'used in the last hour'
    else if (!SETTLED.has(snapshot.status)) keep = `still ${snapshot.status}`
    else if (by.length && !o.all) keep = `used by ${by.join(', ')}`
    else if (o.olderThanMs !== undefined && (since === null || o.now - since < o.olderThanMs)) {
      keep = 'used more recently'
    }
    return { snapshot, keep }
  })
}

/** `--older-than`: `14d`, `12h` or `30m`, in milliseconds. */
export function parseAge(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value.trim())
  const ms = match
    ? Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm']
    : 0
  if (!(ms > 0)) {
    throw new UsageError(`--older-than takes a duration such as 14d, 12h or 30m (got "${value}")`)
  }
  return ms
}

/** `3d ago`, `5h ago`, `just now`. */
export function ago(at: number | null, now = Date.now()): string {
  if (at === null) return '-'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}

/** Which snapshot each target starts from, as names to the targets' ids; each failure apart. */
export async function usedSnapshots(
  targets: VmImageTarget[],
  root: string,
): Promise<{ usedBy: Map<string, string[]>; unknown: { target: VmImageTarget; error: Error }[] }> {
  const usedBy = new Map<string, string[]>()
  const unknown: { target: VmImageTarget; error: Error }[] = []
  await Promise.all(
    targets.map(async (target) => {
      try {
        const name = await vmImageName(target, root)
        usedBy.set(name, [...(usedBy.get(name) ?? []), target.id])
      } catch (error) {
        unknown.push({ target, error: error as Error })
      }
    }),
  )
  return { usedBy, unknown }
}

/** Every account's snapshots, and the accounts that couldn't be listed. */
export async function listAccounts(
  accounts: VmAccount[],
  root: string,
): Promise<{ snapshots: VmSnapshot[]; failed: { account: VmAccount; error: Error }[] }> {
  const failed: { account: VmAccount; error: Error }[] = []
  const lists = await Promise.all(
    accounts.map((account) =>
      listVmSnapshots(account, root).catch((error: Error) => {
        if ((error as { failure?: { usage?: boolean } }).failure?.usage) {
          throw new UsageError(error.message)
        }
        failed.push({ account, error })
        return []
      }),
    ),
  )
  return { snapshots: lists.flat(), failed }
}

/** How messages name an account: `boat (BOAT_API_KEY, reeval-img-…)`. */
export const accountLabel = (a: VmAccount) =>
  `${a.provider} (${a.sandbox.apiKey.from}, ${imagePrefix(a.sandbox.prefix)}…)`

/**
 * `reeval image build --dry-run`: the snapshot each VM image recipe is saved under, and whether
 * its account has it, building nothing.
 */
export async function vmPlanLines(targets: VmImageTarget[], root: string): Promise<string[]> {
  const accounts = vmAccounts(
    targets.map((t) => ({ id: '', sandbox: t.sandbox, harness: t.harness })),
  )
  const { snapshots, failed } = await listAccounts(accounts, root)
  const lines = [
    `vm  ${targets.length} image${targets.length === 1 ? '' : 's'} (nothing built: --dry-run)`,
  ]
  for (const t of targets) {
    const uses = ` · ${t.ids.length} eval${t.ids.length === 1 ? '' : 's'}`
    const name = await vmImageName(t, root).catch((error: Error) => error)
    if (name instanceof Error) {
      lines.push(`  ? ${t.id}${uses}  (unchecked: ${name.message.split('\n')[0]})`)
      continue
    }
    const down = failed.find(
      (f) =>
        f.account.provider === t.provider &&
        f.account.sandbox.apiKey.from === t.sandbox.apiKey.from &&
        f.account.sandbox.prefix === t.sandbox.prefix,
    )
    const saved = snapshots.find(
      (s) => s.provider === t.provider && s.account === t.sandbox.apiKey.from && s.name === name,
    )
    if (down)
      lines.push(`  ? ${t.id}${uses}  ${name}  (unchecked: ${down.error.message.split('\n')[0]})`)
    else if (saved?.status === 'ready' || saved?.status === 'active') {
      lines.push(`  ✓ ${t.id}${uses}  ${name}  (saved)`)
    } else if (saved?.status === 'inactive') {
      lines.push(`  ✓ ${t.id}${uses}  ${name}  (saved, inactive: reactivated on use)`)
    } else
      lines.push(`  + ${t.id}${uses}  ${name}  (to build${saved ? `: it's ${saved.status}` : ''})`)
  }
  return lines
}

export type BuiltVmImage = VmImageTarget &
  (
    | { ok: true; name: string; cached: boolean; ms: number }
    | { ok: false; failure: import('./provider.ts').PrepareFailure; ms: number }
  )

/**
 * `reeval image build`: every VM image recipe in its provider's snapshot, through each provider's
 * `prepare`, as preflight would; one already saved is used as is.
 */
export async function buildVmImages(
  targets: VmImageTarget[],
  root: string,
  options: { log: (line: string) => void; delays?: number[] },
): Promise<BuiltVmImage[]> {
  const { createProviders } = await import('./providers.ts')
  const { prepareAll } = await import('./preflight.ts')
  const providers = createProviders()
  const prepared = targets.map((t) => ({
    kind: t.provider,
    key: (providers[t.provider] as SandboxProvider).key(t.sandbox, t.harness, t.plugins),
    label: t.id,
    sandbox: t.sandbox,
    harness: t.harness,
    plugins: t.plugins,
    setBy: [],
    runWide: false,
  }))
  const images = new Map<object, { name: string; cached: boolean }>()
  const outcomes = await prepareAll(prepared, {
    providers,
    root,
    log: options.log,
    ...(options.delays ? { delays: options.delays } : {}),
    onEvent: (e) => {
      if (e.state !== 'image') return
      const before = images.get(e.target)
      images.set(e.target, {
        name: e.image.name,
        cached: (before?.cached ?? true) && e.image.cached,
      })
    },
  })
  return targets.map((t, i) => {
    const o = outcomes[i] as (typeof outcomes)[number]
    if (!o.ok) return { ...t, ok: false, failure: o.failure, ms: o.ms }
    const image = images.get(prepared[i] as object)
    const handle = o.handle as { snapshot?: unknown; baked?: unknown } | null
    const name = image?.name ?? String(handle?.snapshot ?? handle?.baked ?? '')
    return { ...t, ok: true, name, cached: image?.cached ?? true, ms: o.ms }
  })
}
