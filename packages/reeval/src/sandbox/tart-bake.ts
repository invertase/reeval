// Tart images with a harness baked in: preflight boots the image `tart()` names once, installs the
// pinned pnpm and the harness's CLI with the same bootstrap Docker's images bake, and keeps the
// stopped VM as a local Tart image that each attempt clones (copy-on-write on APFS). The
// bootstrap's marker is in that image, so an attempt's harness finds its CLI and skips the install.
import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import {
  adapterVersion,
  bakedHarnessName,
  bakedRecipe,
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
/**
 * How old a bake's VM is before the next bake takes it for one a killed reeval left: a live bake
 * is stopped only for moments (after its clone, and between its halt and rename), and runs for a
 * few minutes.
 */
const LEFTOVER_STOPPED_MS = 10 * 60_000
const LEFTOVER_RUNNING_MS = 60 * 60_000
/** A bake's VM: the image it makes, `-bake-`, and when it started (base-36 ms) and a nonce. */
const BAKE_VM = /^reeval-sandbox-.+-bake-([0-9a-z]{8,})-[0-9a-f]{4}$/

/** What a harness bakes into a Tart image: its name in the image's, and how to install it. */
export type TartBake = {
  /** The harness and its adapter version (with the patch hash, as Docker's tags have it). */
  label: string
  /** The harness kind, which every bake of it starts its label with. */
  kind: string
  /** How progress names it. */
  name: string
  /** Whether the image gets reeval's pinned pnpm, which the harness bridges install with. */
  pnpm: boolean
  /** A hash of what the bake runs, so a changed bootstrap bakes anew without a version bump. */
  recipe: () => Promise<string>
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
      kind: 'fake',
      name: "the fake agent's bootstrap",
      pnpm: false,
      recipe: async () => fakeBootstrapScript(command),
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
    kind,
    name: bakedHarnessName(kind),
    pnpm: true,
    recipe: () => bakedRecipe(kind),
    install: (session) => bakeHarness(session, kind),
  }
}

/**
 * Which preflight target `sandbox` and `harness` are: one per image, user (the home a bake
 * installs into) and harness bake.
 */
export const tartBakeKey = (sandbox: TartSandboxDescriptor, harness: HarnessDescriptor) =>
  JSON.stringify({
    image: sandbox.image,
    user: sandbox.ssh?.user ?? null,
    bake: tartBake(harness)?.label ?? null,
  })

/** The image's own name and tag, without its registry and owner: `macos-sequoia-base-latest`. */
const slug = (image: string) =>
  (image.split('/').pop() ?? image)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'image'

/**
 * The local Tart image `bake` makes from `sandbox`'s image: the harness and adapter, the base, and
 * a hash of what the bake starts from (an OCI digest, or a local VM's {@link tartSource}
 * fingerprint), the user it installs as, its recipe, pnpm and {@link TART_BAKE_REVISION}, so a
 * change to any of them bakes anew.
 */
export async function bakedTartImage(
  sandbox: TartSandboxDescriptor,
  bake: TartBake,
  source: string | null,
): Promise<string> {
  const inputs = [
    TART_BAKE_REVISION,
    PNPM_VERSION,
    sandbox.image,
    source ?? '',
    sandbox.ssh?.user ?? '',
    await bake.recipe(),
  ]
  const hash = createHash('sha256').update(inputs.join('\0')).digest('hex').slice(0, 8)
  return `reeval-sandbox-${bake.label}-${slug(sandbox.image)}-${hash}`
}

/** Whether `name` is an image a bake made, rather than a VM a bake is running in. */
export const isBakedImage = (name: string) =>
  /^reeval-sandbox-.+-[0-9a-f]{8}$/.test(name) && !BAKE_VM.test(name)

/**
 * Deletes the VMs of bakes a killed reeval left behind (`tart run` outlives it): stopped ones
 * after {@link LEFTOVER_STOPPED_MS}, running ones after {@link LEFTOVER_RUNNING_MS}.
 */
export async function sweepBakeVms(signal: AbortSignal, now = Date.now()): Promise<string[]> {
  const { tartCli, tartVms } = await import('./tart-cli.ts')
  const swept: string[] = []
  for (const vm of await tartVms(signal)) {
    const started = BAKE_VM.exec(vm.name)?.[1]
    if (!started) continue
    const age = now - Number.parseInt(started, 36)
    if (age < (vm.running ? LEFTOVER_RUNNING_MS : LEFTOVER_STOPPED_MS)) continue
    if (vm.running) await tartCli(['stop', '--timeout', '5', vm.name]).catch(() => {})
    await tartCli(['delete', vm.name]).catch(() => {})
    swept.push(vm.name)
  }
  return swept
}

/**
 * Makes {@link bakedTartImage} unless Tart has it (or `force`, which replaces it): clones and
 * boots the base, installs pnpm and the harness, shuts it down and renames it. A failed or
 * canceled bake leaves nothing behind, and each bake first deletes what killed ones left.
 * `built` is false when the image was there already.
 */
export async function bakeTartImage(
  sandbox: TartSandboxDescriptor,
  bake: TartBake,
  o: {
    source: string | null
    force?: boolean
    signal: AbortSignal
    log: (line: string) => void
  },
): Promise<{ image: string; built: boolean; agentVersion: string | null }> {
  const { tartCli, tartNames } = await import('./tart-cli.ts')
  const { bootTartVm, PNPM_DIR, tartSession } = await import('./tart.ts')
  const image = await bakedTartImage(sandbox, bake, o.source)
  for (const vm of await sweepBakeVms(o.signal)) o.log(`Deleted ${vm}, a bake reeval didn't finish`)
  if (!o.force && (await tartNames(o.signal)).has(image)) {
    return { image, built: false, agentVersion: null }
  }
  const vm = `${image}-bake-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
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
    if (o.force) await tartCli(['delete', image], { signal: o.signal })
    const renamed = await tartCli(['rename', vm, image], { signal: o.signal })
    const names = await tartNames(o.signal)
    // Another run baking the same image at once got there first.
    if (renamed.exitCode !== 0 && !names.has(image)) {
      throw new Error(`tart rename failed: ${renamed.stderr.trim() || `exit ${renamed.exitCode}`}`)
    }
    const older = [...names].filter(
      (n) =>
        n !== image &&
        isBakedImage(n) &&
        n.startsWith(`reeval-sandbox-${bake.kind}-`) &&
        n.slice(0, -9).endsWith(`-${slug(sandbox.image)}`),
    )
    if (older.length) {
      o.log(
        `Older bakes of ${bake.name} onto ${sandbox.image}: ${older.join(', ')}. reeval clean --images deletes every baked image that isn't running.`,
      )
    }
    return { image, built: true, agentVersion }
  } finally {
    await halt()
    await tartCli(['delete', vm]).catch(() => {})
  }
}

/** `reeval clean --images`: deletes every image a bake made that isn't running; their names. */
export async function deleteBakedImages(): Promise<string[]> {
  const { tartCli, tartVms } = await import('./tart-cli.ts')
  const deleted: string[] = []
  for (const vm of await tartVms()) {
    if (vm.running || !isBakedImage(vm.name)) continue
    if ((await tartCli(['delete', vm.name])).exitCode === 0) deleted.push(vm.name)
  }
  return deleted
}
