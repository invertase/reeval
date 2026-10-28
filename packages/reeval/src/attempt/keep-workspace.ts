// The attempt's final workspace, kept at teardown as `workspace.tar.gz` in its `.reeval/debug`
// directory: archived in the sandbox, then filtered and masked on the host and written again,
// so what lands on disk went through the same secret masking as everything else reeval writes.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { OPAQUE_OUTPUT } from '@reeval/sandbox-docker'
import { shellQuote } from '@reeval/sandbox-docker/process'
import { debugLog } from '../debug/attempt.ts'
import { KEPT_WORKSPACE_FILE } from '../debug/files.ts'
import { sha256 } from '../ids.ts'
import { findSecrets, redactSecrets } from '../redact.ts'
import type { Sandbox } from '../sandbox/index.ts'
import { readTar, type TarEntry, writeTar } from '../tarball.ts'
import type { KeptWorkspace } from '../types.ts'
import { formatBytes } from '../view/debug.ts'

/** The most a kept workspace may be, compressed; a larger one isn't kept. */
export const KEPT_WORKSPACE_LIMIT = 10 * 2 ** 20
/** The most it may be uncompressed, which the host holds in memory to mask it. */
export const KEPT_WORKSPACE_RAW_LIMIT = 200 * 2 ** 20
/** How long archiving may take before the attempt's teardown goes on without it. */
const ARCHIVE_TIMEOUT_MS = 120_000

/** Installed dependencies, caches and git's objects: left out by directory name, at any depth. */
export const EXCLUDED_DIRS = [
  '.git',
  'node_modules',
  '.pnpm-store',
  '.venv',
  'venv',
  '.tox',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.dart_tool',
  '.gradle',
]

const LISTED = 50
const SIZE_MARK = '--reeval-size--'

const excluded = (path: string) => path.split('/').some((part) => EXCLUDED_DIRS.includes(part))

const utf8 = new TextDecoder('utf-8', { fatal: true })

function asText(data: Buffer): string | null {
  if (data.subarray(0, 8192).includes(0)) return null
  try {
    return utf8.decode(data)
  } catch {
    return null
  }
}

/** The sandbox's archive, with the excluded directories gone and secret-looking values masked. */
export function cleanArchive(tar: Buffer): {
  entries: TarEntry[]
  masked: string[]
  dropped: string[]
  excluded: string[]
} {
  const entries: TarEntry[] = []
  const masked: string[] = []
  const dropped: string[] = []
  const left = new Set<string>()
  for (const e of readTar(tar)) {
    if (excluded(e.path)) {
      const parts = e.path.split('/')
      const at = parts.findIndex((p) => EXCLUDED_DIRS.includes(p))
      left.add(redactSecrets(`${parts.slice(0, at + 1).join('/')}/`))
      continue
    }
    if (findSecrets(e.path).length || (e.type === 'symlink' && findSecrets(e.target).length)) {
      dropped.push(redactSecrets(e.path))
      continue
    }
    if (e.type !== 'file') {
      entries.push(e)
      continue
    }
    const text = asText(e.data)
    if (text === null) {
      if (findSecrets(e.data.toString('latin1')).length) dropped.push(e.path)
      else entries.push(e)
      continue
    }
    const clean = redactSecrets(text)
    if (clean === text) entries.push(e)
    else {
      masked.push(e.path)
      entries.push({ ...e, data: Buffer.from(clean) })
    }
  }
  return { entries, masked, dropped, excluded: [...left] }
}

const tarCommand = (workdir: string) => {
  const flags = EXCLUDED_DIRS.map((d) => `--exclude=${shellQuote(d)}`).join(' ')
  return `cd ${shellQuote(workdir)} && COPYFILE_DISABLE=1 tar -cf - ${flags} . 2>/dev/null`
}
const GZIP = 'if command -v gzip >/dev/null 2>&1; then gzip -c; else cat; fi'
const NEEDS_TAR =
  "command -v tar >/dev/null 2>&1 || { echo 'the sandbox has no tar' >&2; exit 127; }"

const listed = (paths: string[]) => paths.slice(0, LISTED)

/**
 * Archives the sandbox's workspace and returns what to record and the bytes to write, or why
 * none: over `limit` compressed or `rawLimit` uncompressed, or an archive the sandbox couldn't
 * make.
 */
export async function archiveWorkspace(
  box: Sandbox,
  signal: AbortSignal,
  limit = KEPT_WORKSPACE_LIMIT,
  rawLimit = KEPT_WORKSPACE_RAW_LIMIT,
): Promise<{ kept: KeptWorkspace; archive: Buffer | null }> {
  const none = (cause: 'size' | 'error', message: string, dirs: string[] = []) => ({
    kept: {
      sha256: null,
      bytes: 0,
      files: 0,
      excluded: listed(dirs),
      masked: [],
      dropped: [],
      skipped: { cause, message },
    },
    archive: null,
  })
  const names = EXCLUDED_DIRS.map((d) => `-name ${shellQuote(d)}`).join(' -o ')
  const tar = tarCommand(box.workdir)
  const sized = await box.execOwn(
    `${NEEDS_TAR}; cd ${shellQuote(box.workdir)} && { find . -type d \\( ${names} \\) -prune -print 2>/dev/null | head -n ${LISTED}; echo ${SIZE_MARK}; ${tar} | wc -c; echo ${SIZE_MARK}; ${tar} | { ${GZIP}; } | wc -c; }`,
    { signal },
  )
  const [list = '', raw = '', size = ''] = sized.stdout.split(`${SIZE_MARK}\n`)
  const dirs = list
    .split('\n')
    .filter(Boolean)
    .map((p) => redactSecrets(`${p.replace(/^\.\//, '')}/`))
  const rawBytes = Number(raw.trim())
  const bytes = Number(size.trim())
  if (sized.exitCode !== 0 || !(rawBytes > 0) || !(bytes > 0)) {
    return none('error', `couldn't archive the workspace: ${(sized.stderr || sized.stdout).trim()}`)
  }
  const without = dirs.length ? dirs.join(', ') : 'its dependency and cache directories'
  if (rawBytes > rawLimit) {
    return none(
      'size',
      `the workspace is ${formatBytes(rawBytes)} without ${without}, over the ${formatBytes(rawLimit)} cap`,
      dirs,
    )
  }
  if (bytes > limit) {
    return none(
      'size',
      `the workspace is ${formatBytes(bytes)} compressed without ${without}, over the ${formatBytes(limit)} cap`,
      dirs,
    )
  }
  // Opaque, so a debug trace of the command counts the archive rather than keeping it unmasked.
  const r = await box.execOwn(
    `${NEEDS_TAR}; echo ${OPAQUE_OUTPUT}; ${tar} | { ${GZIP}; } | base64`,
    { signal },
  )
  const encoded = r.stdout.startsWith(`${OPAQUE_OUTPUT}\n`)
    ? r.stdout.slice(OPAQUE_OUTPUT.length + 1)
    : ''
  const fetched = Buffer.from(encoded, 'base64')
  if (r.exitCode !== 0 || fetched.length === 0) {
    return none('error', `couldn't archive the workspace: ${r.stderr.trim() || 'no output'}`)
  }
  const plain =
    fetched[0] === 0x1f && fetched[1] === 0x8b
      ? gunzipSync(fetched, { maxOutputLength: rawLimit + 2 ** 20 })
      : fetched
  const clean = cleanArchive(plain)
  const archive = gzipSync(writeTar(clean.entries))
  if (archive.length > limit) {
    return none(
      'size',
      `the workspace is ${formatBytes(archive.length)} compressed, over the ${formatBytes(limit)} cap`,
    )
  }
  const all = [...new Set([...dirs, ...clean.excluded])].sort()
  return {
    kept: {
      sha256: sha256(archive),
      bytes: archive.length,
      files: clean.entries.filter((e) => e.type !== 'dir').length,
      excluded: listed(all),
      masked: listed(clean.masked),
      dropped: listed(clean.dropped),
      skipped: null,
    },
    archive,
  }
}

/**
 * Keeps the workspace into `dir` (the attempt's debug directory); never fails the attempt.
 * Undefined when `signal` (the attempt's) stopped it.
 */
export async function keepWorkspace(
  box: Sandbox,
  dir: string,
  signal: AbortSignal,
  timeoutMs = ARCHIVE_TIMEOUT_MS,
): Promise<KeptWorkspace | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const failed = (message: string): KeptWorkspace => {
    debugLog('teardown', `didn't keep the workspace: ${message}`)
    return {
      sha256: null,
      bytes: 0,
      files: 0,
      excluded: [],
      masked: [],
      dropped: [],
      skipped: { cause: 'error', message: `couldn't archive the workspace: ${message}` },
    }
  }
  try {
    const { kept, archive } = await archiveWorkspace(box, AbortSignal.any([signal, timeout]))
    if (archive) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, KEPT_WORKSPACE_FILE), archive)
      const masked = kept.masked.length ? ` · masked ${kept.masked.length}` : ''
      debugLog(
        'teardown',
        `kept the workspace: ${kept.files} files, ${formatBytes(kept.bytes)} → ${KEPT_WORKSPACE_FILE}${masked}${kept.excluded.length ? ` · left out ${kept.excluded.join(', ')}` : ''}`,
      )
    } else {
      debugLog('teardown', `didn't keep the workspace: ${kept.skipped?.message}`)
    }
    return kept
  } catch (error) {
    if (signal.aborted) return undefined
    if (timeout.aborted) return failed(`it took over ${Math.round(timeoutMs / 1000)}s`)
    return failed(error instanceof Error ? error.message : String(error))
  }
}
