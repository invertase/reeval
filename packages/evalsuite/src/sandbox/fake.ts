import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FakeSandboxDescriptor } from '../types.ts'
import { spawnCollect } from './exec.ts'
import type { Sandbox } from './types.ts'

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

  return {
    workdir,
    exec: (command, opts) =>
      spawnCollect('sh', ['-c', command], { cwd: workdir, env: { HOME: base, ...env }, ...opts }),
    home: base,
    readFile: (path) => readFile(join(workdir, path), 'utf8').catch(() => null),
    async writeFile(path, content) {
      const target = path.startsWith('~/') ? join(base, path.slice(2)) : join(workdir, path)
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
