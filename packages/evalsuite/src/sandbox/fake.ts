import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import type { EgressCapabilities } from '@evalsuite/sandbox-docker'
import { run, shellQuote } from '@evalsuite/sandbox-docker/process'
import { UsageError } from '../errors.ts'
import type { FakeSandboxDescriptor } from '../types.ts'
import type { Sandbox } from './types.ts'

/** Commands run on the host's own network, so the fake sandbox can neither restrict nor see it. */
export const FAKE_EGRESS: EgressCapabilities = { enforce: 'none', record: false }

/**
 * The POSIX shell commands run in: `sh`, which Windows lacks, so there the `sh.exe` on PATH or
 * Git for Windows'.
 */
export function posixShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== 'win32') return 'sh'
  const onPath = (env.PATH ?? env.Path ?? '').split(win32.delimiter).filter(Boolean)
  const git = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs'),
  ]
    .filter((dir): dir is string => !!dir)
    .map((dir) => win32.join(dir, 'Git', 'bin'))
  const found = [...onPath, ...git].map((dir) => win32.join(dir, 'sh.exe')).find(exists)
  if (found) return found
  throw new UsageError(
    "The fake sandbox runs commands with a POSIX sh, and there's none on this machine. Install Git for Windows (https://git-scm.com/download/win), which brings sh.exe, or run the evals in docker().",
  )
}

const EXEC_TAG = 'ES_FAKE_EXEC'

// Kills every MSYS process whose environment carries the command's tag, until none is left.
const KILL_TAGGED = `for pass in 1 2 3 4 5; do
  found=
  for f in $(grep -lzx "${EXEC_TAG}=$1" /proc/[0-9]*/environ 2>/dev/null); do
    p=\${f#/proc/}; kill -9 "\${p%/environ}" 2>/dev/null; found=1
  done
  [ -n "$found" ] || break
done`

/**
 * Stops a command's MSYS processes on Windows. `taskkill /t` doesn't reach them: Git's `sh.exe`
 * starts bash, whose fork and exec leave each new process's Windows parent gone, so a timed-out
 * `sleep 30` would run on, holding the command's pipes and working directory.
 */
function killTagged(sh: string, tag: string) {
  spawn(sh, ['-c', KILL_TAGGED, 'sh', tag], {
    stdio: 'ignore',
    windowsHide: true,
  }).on('error', () => {})
}

/**
 * A temp directory on the host. Commands run unisolated on the host shell, so this is
 * only meant for tests and for the fake harness.
 */
export async function createFakeSandbox(
  descriptor: FakeSandboxDescriptor,
  env: Record<string, string> = {},
): Promise<Sandbox> {
  const sh = posixShell()
  const parent = descriptor.dir ?? tmpdir()
  await mkdir(parent, { recursive: true })
  const base = await mkdtemp(join(parent, 'es-sandbox-'))
  const workdir = join(base, 'work')
  await mkdir(workdir)
  let destroyed: Promise<void> | undefined
  const resolve = (path: string) =>
    path.startsWith('~/') ? join(base, path.slice(2)) : join(workdir, path)

  return {
    workdir,
    // The shell changes into `cwd`, so a missing one fails the command (as in Docker) rather
    // than the spawn.
    exec: (command, { cwd, env: extra, signal } = {}) => {
      const tag = process.platform === 'win32' && signal ? randomUUID() : undefined
      const stop = () => killTagged(sh, tag as string)
      if (tag) signal?.addEventListener('abort', stop, { once: true })
      return run(sh, ['-c', cwd ? `cd ${shellQuote(cwd)} && ${command}` : command], {
        cwd: workdir,
        env: { HOME: base, ...env, ...extra, ...(tag ? { [EXEC_TAG]: tag } : {}) },
        signal,
      }).finally(() => signal?.removeEventListener('abort', stop))
    },
    home: base,
    readFile: (path) => readFile(resolve(path), 'utf8').catch(() => null),
    async writeFile(path, content) {
      const target = resolve(path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    },
    // An abort destroys the sandbox while the body may still be writing into it, so a later
    // call removes again instead of reusing the settled promise.
    destroy: () => {
      destroyed ??= rm(base, { recursive: true, force: true })
        .catch(() => {})
        .finally(() => {
          destroyed = undefined
        })
      return destroyed
    },
  }
}
