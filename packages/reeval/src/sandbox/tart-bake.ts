// Tart images with a harness baked in: preflight boots the image `tart()` names once, installs the
// pinned pnpm and the harness's CLI with the same bootstrap Docker's images bake, and keeps the
// stopped VM as a local Tart image that each attempt clones (copy-on-write on APFS). The
// bootstrap's marker is in that image, so an attempt's harness finds its CLI and skips the install.
import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import {
  adapterVersion,
  bakedHarnessName,
  bakeHarness,
  type DockerSession,
  isBakedHarness,
  PNPM_VERSION,
} from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import { fakeBootstrapId, fakeBootstrapScript } from '../harness/fake-bootstrap.ts'
import type { HarnessDescriptor, TartSandboxDescriptor } from '../types.ts'

/**
 * How reeval bakes a Tart image, beyond the adapter and pnpm: bump it when that changes what a
 * baked image holds, so every image baked before is baked anew on its next use.
 */
const TART_BAKE_REVISION = 1
/** How long a baked VM gets to shut down cleanly, so its disk holds everything the bake wrote. */
const SHUTDOWN_S = 120

/** What a harness bakes into a Tart image: its name in the image's, and how to install it. */
export type TartBake = {
  /** The harness and its adapter version (with the patch hash, as Docker's tags have it). */
  label: string
  /** How progress names it. */
  name: string
  /** Whether the image gets reeval's pinned pnpm, which the harness bridges install with. */
  pnpm: boolean
  /** Installs the CLI in `session` and returns the version it installed. */
  install: (session: DockerSession) => Promise<string>
}

/** The bake `harness` needs in `tart()`; null for a fake agent with nothing to install. */
export function tartBake(harness: HarnessDescriptor): TartBake | null {
  if (harness.kind === 'fake') {
    const command = harness.bootstrap
    if (!command) return null
    return {
      label: `fake-${fakeBootstrapId(command)}`,
      name: "the fake agent's bootstrap",
      pnpm: false,
      async install(session) {
        const r = await session.run({ command: fakeBootstrapScript(command) })
        if (r.exitCode !== 0) {
          throw new Error(
            `The fake agent's bootstrap exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-500)}`,
          )
        }
        return 'fake'
      },
    }
  }
  const kind = harness.kind
  if (!isBakedHarness(kind)) return null
  return {
    label: `${kind}-${adapterVersion(kind)}`,
    name: bakedHarnessName(kind),
    pnpm: true,
    install: (session) => bakeHarness(session, kind),
  }
}

/** The image's own name and tag, without its registry and owner: `macos-sequoia-base-latest`. */
const slug = (image: string) =>
  (image.split('/').pop() ?? image)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

/**
 * The local Tart image `bake` makes from `base`: the harness and adapter, the base, and a hash of
 * the base's digest (null for a local VM), pnpm and {@link TART_BAKE_REVISION}, so a moved tag or a
 * new adapter bakes anew.
 */
export const bakedTartImage = (
  bake: Pick<TartBake, 'label'>,
  base: string,
  digest: string | null,
) =>
  `reeval-sandbox-${bake.label}-${slug(base) || 'image'}-${createHash('sha256')
    .update(`${TART_BAKE_REVISION}\0${PNPM_VERSION}\0${base}\0${digest ?? ''}`)
    .digest('hex')
    .slice(0, 8)}`

/**
 * Makes {@link bakedTartImage} unless Tart has it: clones and boots the base, installs pnpm and the
 * harness, shuts it down and renames it. A failed or canceled bake leaves nothing behind. `built`
 * is false when the image was there already.
 */
export async function bakeTartImage(
  sandbox: TartSandboxDescriptor,
  bake: TartBake,
  o: { digest: string | null; signal: AbortSignal; log: (line: string) => void },
): Promise<{ image: string; built: boolean; agentVersion: string | null }> {
  const { tartCli, tartNames } = await import('./tart-cli.ts')
  const { bootTartVm, PNPM_DIR, tartSession } = await import('./tart.ts')
  const image = bakedTartImage(bake, sandbox.image, o.digest)
  if ((await tartNames(o.signal)).has(image)) return { image, built: false, agentVersion: null }
  const vm = `${image}-bake-${randomBytes(3).toString('hex')}`
  o.log(`Baking ${bake.name} onto ${sandbox.image} as ${image}`)
  const { guest, home, halt } = await bootTartVm(sandbox, sandbox.image, vm, o.signal)
  try {
    const stateDir = posix.join(home, '.reeval-state')
    const session = tartSession({
      vm,
      guest,
      home,
      stateDir,
      env: {},
      gateway: undefined,
      destroy: async () => {},
    })
    const run = async (command: string, what: string) => {
      const r = await session.run({ command, abortSignal: o.signal })
      if (r.exitCode !== 0) {
        throw new Error(
          `${what} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-500)}`,
        )
      }
    }
    await run(`umask 022 && mkdir -p ${q(stateDir)} && chmod 700 ${q(stateDir)}`, 'mkdir')
    if (bake.pnpm) {
      o.log(`Installing pnpm ${PNPM_VERSION}`)
      await run(
        `npm install --global --no-fund --no-audit --prefix ${q(posix.join(home, PNPM_DIR))} pnpm@${PNPM_VERSION} && pnpm --version`,
        `npm install pnpm@${PNPM_VERSION}`,
      )
    }
    o.log(`Installing ${bake.name}`)
    const agentVersion = await bake.install(session)
    o.log(`${bake.name} ${agentVersion}`)
    await run(`rm -f ${q(stateDir)}/exec-*.pid; sync`, 'sync')
    await halt(SHUTDOWN_S)
    const renamed = await tartCli(['rename', vm, image], { signal: o.signal })
    // Another run baking the same image at once got there first.
    if (renamed.exitCode !== 0 && !(await tartNames(o.signal)).has(image)) {
      throw new Error(`tart rename failed: ${renamed.stderr.trim() || `exit ${renamed.exitCode}`}`)
    }
    return { image, built: true, agentVersion }
  } finally {
    await halt()
    await tartCli(['delete', vm]).catch(() => {})
  }
}
