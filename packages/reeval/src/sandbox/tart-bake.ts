// Tart images with a harness baked in: preflight boots the image `tart()` names once, installs the
// pinned pnpm and the harness's CLI with the same bootstrap Docker's images bake, and keeps the
// stopped VM as a local Tart image that each attempt clones (copy-on-write on APFS). The
// bootstrap's marker is in that image, so an attempt's harness finds its CLI and skips the install.
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { bakeKey, PNPM_VERSION } from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import type { HarnessDescriptor, TartSandboxDescriptor } from '../types.ts'
import { type HarnessBake, harnessBake, installHarness } from './harness-install.ts'
import type { TartTarget } from './tart-cli.ts'

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

/**
 * Which preflight target `sandbox` and `harness` are: one per image, user (the home a bake
 * installs into), harness bake and the hosts it bakes on.
 */
export const tartBakeKey = (sandbox: TartSandboxDescriptor, harness: HarnessDescriptor) =>
  JSON.stringify({
    image: sandbox.image,
    user: sandbox.ssh?.user ?? null,
    bake: harnessBake(harness)?.label ?? null,
    ...(sandbox.hosts && { hosts: sandbox.hosts }),
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
 * the {@link bakeKey} of what the bake starts from (an OCI digest, or a local VM's
 * {@link tartSource} fingerprint), the user it installs as, its recipe and pnpm.
 */
export async function bakedTartImage(
  sandbox: TartSandboxDescriptor,
  bake: HarnessBake,
  source: string | null,
): Promise<string> {
  const hash = bakeKey(
    PNPM_VERSION,
    sandbox.image,
    source ?? '',
    sandbox.ssh?.user ?? '',
    await bake.recipe(),
  )
  return `reeval-sandbox-${bake.label}-${slug(sandbox.image)}-${hash}`
}

/** Whether `name` is an image a bake made, rather than a VM a bake is running in. */
export const isBakedImage = (name: string) =>
  /^reeval-sandbox-.+-[0-9a-f]{8}$/.test(name) && !BAKE_VM.test(name)

/**
 * Deletes the VMs of bakes a killed reeval left behind (`tart run` outlives it): stopped ones
 * after {@link LEFTOVER_STOPPED_MS}, running ones after {@link LEFTOVER_RUNNING_MS}.
 */
export async function sweepBakeVms(
  signal: AbortSignal,
  now = Date.now(),
  on?: TartTarget,
): Promise<string[]> {
  const { tartCli, tartVms } = await import('./tart-cli.ts')
  const swept: string[] = []
  const where = on ? { on } : {}
  for (const vm of await tartVms(signal, on)) {
    const started = BAKE_VM.exec(vm.name)?.[1]
    if (!started) continue
    const age = now - Number.parseInt(started, 36)
    if (age < (vm.running ? LEFTOVER_RUNNING_MS : LEFTOVER_STOPPED_MS)) continue
    if (vm.running) await tartCli(['stop', '--timeout', '5', vm.name], where).catch(() => {})
    await tartCli(['delete', vm.name], where).catch(() => {})
    swept.push(vm.name)
  }
  return swept
}

/**
 * Makes {@link bakedTartImage} unless Tart has it (or `force`, which replaces it): clones and
 * boots the base, installs pnpm and the harness, shuts it down and renames it. A failed or
 * canceled bake leaves nothing behind, and each bake first deletes what killed ones left.
 * `built` is false when the image was there already. With `on`, it all happens on that Mac.
 */
export async function bakeTartImage(
  sandbox: TartSandboxDescriptor,
  bake: HarnessBake,
  o: {
    source: string | null
    force?: boolean
    signal: AbortSignal
    log: (line: string) => void
    on?: TartTarget
  },
): Promise<{ image: string; built: boolean; agentVersion: string | null }> {
  const { LOCAL_TART, tartCli, tartNames } = await import('./tart-cli.ts')
  const { bootTartVm, PNPM_DIR, tartSession } = await import('./tart.ts')
  const on = o.on ?? LOCAL_TART
  const image = await bakedTartImage(sandbox, bake, o.source)
  for (const vm of await sweepBakeVms(o.signal, Date.now(), on)) {
    o.log(`Deleted ${vm}, a bake reeval didn't finish`)
  }
  if (!o.force && (await tartNames(o.signal, on)).has(image)) {
    return { image, built: false, agentVersion: null }
  }
  const vm = `${image}-bake-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
  o.log(`Baking ${bake.name} onto ${sandbox.image} as ${image}`)
  const { guest, home, halt } = await bootTartVm(sandbox, sandbox.image, vm, o.signal, on)
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
    const agentVersion = await installHarness(session, bake, {
      pnpmPrefix: posix.join(home, PNPM_DIR),
      signal: o.signal,
      log: o.log,
    })
    o.log(`${bake.name} ${agentVersion}`)
    await run(`rm -f ${q(stateDir)}/exec-*.pid; sync`, 'sync')
    await halt(SHUTDOWN_S)
    if (o.force) await tartCli(['delete', image], { signal: o.signal, on })
    const renamed = await tartCli(['rename', vm, image], { signal: o.signal, on })
    const names = await tartNames(o.signal, on)
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
    await tartCli(['delete', vm], { on }).catch(() => {})
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
