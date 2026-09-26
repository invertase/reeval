import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { EgressCapabilities } from '@evalsuite/sandbox-docker'
import { run, shellQuote } from '@evalsuite/sandbox-docker/process'
import type { FakeSandboxDescriptor } from '../types.ts'
import type { Sandbox } from './types.ts'

/** Commands run on the host's own network, so the fake sandbox can neither restrict nor see it. */
export const FAKE_EGRESS: EgressCapabilities = { enforce: 'none', record: false }

/**
 * A temp directory on the host. Commands run unisolated on the host shell, so this is
 * only meant for tests and for the fake harness.
 */
export async function createFakeSandbox(
  descriptor: FakeSandboxDescriptor,
  env: Record<string, string> = {},
): Promise<Sandbox> {
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
    exec: (command, { cwd, env: extra, signal } = {}) =>
      run('sh', ['-c', cwd ? `cd ${shellQuote(cwd)} && ${command}` : command], {
        cwd: workdir,
        env: { HOME: base, ...env, ...extra },
        signal,
      }),
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
