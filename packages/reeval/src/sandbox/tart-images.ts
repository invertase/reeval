// The images `tart()` clones: how Tart names and stores them, what one weighs before it's pulled,
// and what `reeval run` and `reeval image build` say about the ones Tart doesn't have. A run never
// pulls: `reeval image build` (or `tart pull`) does, first.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readdir, readlink, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseTartRef } from './tart-ref.ts'

/** Tart's own directory: `TART_HOME`, or `~/.tart`. */
export const tartHome = () => process.env.TART_HOME || join(homedir(), '.tart')

/**
 * The digest of the pulled image `image` names: its own, or the one its tag points to in Tart's
 * cache (`cache/OCIs/<host>/<repo>/<tag>`, a link to the `sha256:…` directory by absolute path).
 * Null for a local VM, which has none, or when the cache doesn't say. Read at preflight, so a
 * `tart pull` of the same tag between then and the clone isn't seen.
 */
export async function tartDigest(image: string): Promise<string | null> {
  const ref = parseTartRef(image)
  if (!ref.oci) return null
  if (ref.digest) return ref.digest
  const link = join(tartHome(), 'cache', 'OCIs', ref.host, ref.repo, ref.tag ?? 'latest')
  const target = await readlink(link).catch(() => null)
  const digest = target && basename(target)
  return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null
}

/** What an image weighs: its layers to download, and what Tart unpacks them to (when it says). */
export type TartSize = { download: number; disk: number | null }

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
/** The annotation Tart puts on each disk layer: its size once decompressed. */
const UNCOMPRESSED = 'org.cirruslabs.tart.uncompressed-size'

type Manifest = { layers?: Array<{ size?: number; annotations?: Record<string, string> }> }

/** An image's size from its registry's manifest, anonymously; null when that can't be had. */
export async function tartImageSize(image: string, signal?: AbortSignal): Promise<TartSize | null> {
  const ref = parseTartRef(image)
  if (!ref.oci) return null
  // A registry on this machine speaks plain HTTP, as Docker assumes of one.
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(ref.host)
  const url = `${local ? 'http' : 'https'}://${ref.host}/v2/${ref.repo}/manifests/${ref.digest ?? ref.tag ?? 'latest'}`
  try {
    let res = await fetch(url, { headers: { Accept: MANIFEST }, signal })
    if (res.status === 401) {
      const token = await anonymousToken(res.headers.get('www-authenticate'), signal)
      if (!token) return null
      res = await fetch(url, {
        headers: { Accept: MANIFEST, Authorization: `Bearer ${token}` },
        signal,
      })
    }
    if (!res.ok) return null
    const layers = ((await res.json()) as Manifest).layers ?? []
    if (!layers.length) return null
    const download = layers.reduce((n, l) => n + (l.size ?? 0), 0)
    const annotated = layers.some((l) => l.annotations?.[UNCOMPRESSED])
    const disk = annotated
      ? layers.reduce((n, l) => n + Number(l.annotations?.[UNCOMPRESSED] ?? l.size ?? 0), 0)
      : null
    return { download, disk }
  } catch {
    return null
  }
}

/** A pull token for a `Bearer realm=…,service=…,scope=…` challenge, asked for without credentials. */
async function anonymousToken(
  challenge: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!challenge?.startsWith('Bearer ')) return null
  const params = Object.fromEntries(
    [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  )
  if (!params.realm) return null
  const url = new URL(params.realm)
  for (const key of ['service', 'scope']) {
    if (params[key]) url.searchParams.set(key, params[key])
  }
  const res = await fetch(url, { signal })
  if (!res.ok) return null
  const body = (await res.json()) as { token?: string; access_token?: string }
  return body.token ?? body.access_token ?? null
}

/** `25 GB`, `1.4 GB`, `300 MB`: decimal units, as Tart prints sizes. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9)
    return `${bytes >= 1e10 ? Math.round(bytes / 1e9) : (bytes / 1e9).toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/** What Tart needs free for a pull: the unpacked disk, and the 128 MiB it keeps besides. */
export const pullNeeds = (size: TartSize) => (size.disk ?? size.download) + 134_217_728

/**
 * The bytes free for Tart on the volume its home is on (or will be on). The test suite sets
 * REEVAL_TEST_TART_FREE_BYTES to put a disk's edge where it wants one.
 */
export async function tartFreeBytes(): Promise<number | null> {
  const stand = process.env.REEVAL_TEST_TART_FREE_BYTES
  if (stand) return Number(stand)
  let dir = tartHome()
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
  const stats = await statfs(dir).catch(() => null)
  return stats ? stats.bavail * stats.bsize : null
}

/**
 * The bytes Tart's cache (`cache/`: pulled images and IPSWs) takes on disk, which `tart pull`
 * prunes to make room unless `TART_NO_AUTO_PRUNE` is set.
 */
export async function tartPrunableBytes(): Promise<number> {
  if (process.env.TART_NO_AUTO_PRUNE) return 0
  const walk = async (dir: string): Promise<number> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    let n = 0
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) n += await walk(path)
      // Disks are sparse: what a file holds, not its length.
      else if (e.isFile())
        n += await lstat(path).then(
          (s) => s.blocks * 512,
          () => 0,
        )
    }
    return n
  }
  return walk(join(tartHome(), 'cache'))
}

/** An image the plan needs and Tart doesn't have, with what it weighs when the registry says. */
export type MissingImage = { image: string; size: TartSize | null }

/**
 * Whether the images to pull fit: what they need (the ones the registry sized), what's free in
 * Tart's home, and what Tart would prune from its cache to make room.
 */
export type PullSpace = {
  needs: number
  free: number
  prunable: number
  dir: string
  unsized: string[]
  /** `fits` in what's free; `prunes`, once Tart prunes its cache; `short` either way. */
  verdict: 'fits' | 'prunes' | 'short'
}

/** The disk check for pulling `missing`; null when the free space can't be read. */
export async function pullSpace(missing: MissingImage[]): Promise<PullSpace | null> {
  const free = await tartFreeBytes()
  if (free === null) return null
  const needs = missing.reduce((n, m) => n + (m.size ? pullNeeds(m.size) : 0), 0)
  const prunable = needs > free ? await tartPrunableBytes() : 0
  const verdict = needs <= free ? 'fits' : needs <= free + prunable ? 'prunes' : 'short'
  const unsized = missing.filter((m) => !m.size).map((m) => m.image)
  return { needs, free, prunable, dir: tartHome(), unsized, verdict }
}

const uncounted = (unsized: string[]) =>
  unsized.length
    ? `, not counting ${unsized.length === 1 ? 'one image' : `${unsized.length} images`} the registry didn't size`
    : ''

/** `reeval image build --dry-run`'s line for the disk check. */
export function pullSpaceLine(space: PullSpace): string {
  if (!space.needs) {
    const one = space.unsized.length === 1
    return `disk  ${formatSize(space.free)} free in ${space.dir}; the registry didn't size ${one ? 'the image' : 'the images'} to pull, so the disk check can't count ${one ? 'it' : 'them'}`
  }
  const head = `disk  needs about ${formatSize(space.needs)} in ${space.dir}${uncounted(space.unsized)}; ${formatSize(space.free)} free`
  if (space.verdict === 'fits') return head
  const cache = `${formatSize(space.prunable)} in Tart's cache`
  return space.verdict === 'prunes'
    ? `${head}, and Tart prunes its cache (${cache}) to make room`
    : `${head}${space.prunable ? ` and ${cache}` : ''}: reeval image build refuses to pull`
}

/** The warning when a pull fits only once Tart prunes images it cached. */
export function pullPruneWarning(space: PullSpace): string {
  return `warning: pulling needs about ${formatSize(space.needs)} in ${space.dir} and ${formatSize(space.free)} is free: tart pull will prune images it cached (${formatSize(space.prunable)}) to make room.`
}

const sized = ({ size }: MissingImage) =>
  size ? ` (about ${formatSize(size.download)} to download)` : ''

/**
 * Why `reeval run` won't start: the images Tart doesn't have, each with how to fetch it. A run
 * doesn't pull, since one can take an hour.
 */
export function missingImagesMessage(missing: MissingImage[]): string {
  const oci = missing.filter((m) => parseTartRef(m.image).oci)
  const local = missing.filter((m) => !parseTartRef(m.image).oci)
  const one = missing.length === 1
  const lines = [
    `Tart doesn't have ${one ? 'the image' : `${missing.length} images`} tart() clones, and reeval run doesn't pull images:`,
    ...missing.map((m) => `  ${m.image}${sized(m)}`),
  ]
  if (oci.length) {
    const it = oci.length === 1 ? 'it' : 'them'
    lines.push(
      `Pull ${it} with ${oci.map((m) => `tart pull ${m.image}`).join(', ')}, or pull every image the plan needs with reeval image build, then run again.`,
    )
  }
  for (const m of local) {
    lines.push(
      `${m.image} names a local VM (an OCI image has a registry host, such as ghcr.io/…): make it with tart clone or tart create, or name an image to pull.`,
    )
  }
  return lines.join('\n')
}

/**
 * Why `reeval image build` won't pull: the images' unpacked disks don't fit in what's free, even
 * once Tart prunes its cache.
 */
export function pullSpaceMessage(missing: MissingImage[], space: PullSpace): string {
  const one = missing.length === 1
  const cache = space.prunable
    ? `, plus ${formatSize(space.prunable)} of images Tart cached and would prune`
    : ''
  return [
    `Not enough disk space to pull ${one ? 'the image' : `${missing.length} images`} tart() clones: Tart needs about ${formatSize(space.needs)} free in ${space.dir}${uncounted(space.unsized)}; there is ${formatSize(space.free)}${cache}.`,
    ...missing.map(
      (m) =>
        `  ${m.image} (${m.size ? `about ${formatSize(m.size.download)} to download, ${formatSize(pullNeeds(m.size))} on disk` : 'size unknown, not counted'})`,
    ),
    'Free some space, or set TART_HOME to a bigger volume, then run reeval image build again.',
  ].join('\n')
}

/**
 * `tart pull image`, its progress to `onLine`: each line it prints, and its percentages once
 * every ten points. Rejects with its last lines when it fails.
 */
export function tartPull(
  image: string,
  options: { signal?: AbortSignal; onLine?: (line: string) => void } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tart', ['pull', image], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const tail: string[] = []
    let shown = -10
    let last = ''
    const take = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/[\r\n]+/)) {
        const line = raw.trim()
        if (!line || line === last) continue
        last = line
        tail.push(line)
        if (tail.length > 20) tail.shift()
        const percent = /(\d+(?:\.\d+)?)\s*%/.exec(line)
        if (percent) {
          const at = Math.floor(Number(percent[1]) / 10) * 10
          if (at < shown + 10) continue
          shown = at
        }
        options.onLine?.(line)
      }
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`tart pull ${image} failed: ${tail.slice(-5).join('\n') || `exit ${code}`}`))
    })
  })
}
