import {
  type DockerSession,
  type EgressStatus,
  type ExecTransport,
  type Gateway,
  startGateway,
} from '@reeval/sandbox-docker'
import type { AttemptDebug } from '../debug/attempt.ts'
import { egressLabel, isRestricted, setupEgress } from '../egress.ts'
import { gatewayGlue, sessionSandbox } from './docker.ts'
import { harnessBake, installHarness } from './harness-install.ts'
import type { SandboxOptions } from './index.ts'
import { InfraError, type NetworkSandbox } from './types.ts'

/** How long installing the harness's CLI in a new machine may take. */
const INSTALL_TIMEOUT_MS = 10 * 60_000

/**
 * Brokered values never enter the sandbox: with no gateway to swap them in, the attempt can't
 * start. `helper` names the sandbox (`boat()`), `hint` says what the gateway needs there.
 */
export const brokeringRefusal = (
  helper: string,
  brokered: readonly string[],
  reason: string,
  hint?: string,
) =>
  new InfraError(
    `Can't keep ${brokered.join(', ')} out of the ${helper} sandbox: credential brokering could not start (${reason})${hint ? `. ${hint}` : ''}`,
  )

/** The debug line saying whether the gateway runs and what it brokers. */
export function logGateway(
  debug: AttemptDebug | undefined,
  egress: EgressStatus | undefined,
  brokered: readonly string[],
): void {
  debug?.log(
    'container',
    egress?.active
      ? `egress gateway started · brokers ${brokered.join(', ') || 'nothing'}`
      : `egress gateway not running: ${egress?.reason ?? 'not asked for'}`,
  )
}

/** A machine that's up, with its user and directories made, before the gateway starts. */
export type BootedMachine = {
  /** Runs the gateway's forwarder as root. */
  root: ExecTransport
  /** Runs once the gateway has started, before the session: trusting its CA where the gateway can't. */
  onGateway?(gateway: Gateway, signal: AbortSignal): Promise<void>
  /** The machine as a harness session; its destroy is `destroy`, which closes the gateway first. */
  session(o: {
    gateway: Gateway | undefined
    noGateway: string | undefined
    destroy: () => Promise<void>
  }): DockerSession
  /** Where reeval's own privileged commands run, when not `SANDBOX_STATE`. */
  stateDir?: string
  /** The gateway's port in the machine, when it isn't the machine's only one. */
  proxyPort?: number
  /** The harness's CLI is already in the machine, from an attempt before. */
  installed?: boolean
  /**
   * Once the gateway runs: waits for the harness's CLI another of the machine's attempts installs,
   * whether it's now in this one's home, or this attempt is to install it.
   */
  installedElsewhere?(): Promise<boolean>
  /** Runs once the harness's CLI has installed. */
  onInstalled?(): Promise<void>
  /** Starting the sandbox failed after the boot: `destroy` follows, and the machine isn't reused. */
  failed?(): void
  /** Removes the machine. */
  destroy(): Promise<void>
}

export type StartOptions = {
  /** How messages name the sandbox: `boat()`, `tart()`. */
  helper: string
  /** The machine as the record names it: its provider and size. */
  machine: { sandbox: string; size?: string }
  /** Other attempts run on the machine at the same time, so its usage isn't recorded. */
  shared?: boolean
  /** A macOS guest, which has no `/proc` to read usage from, only its sizes. */
  darwin?: boolean
  /** What the gateway needs on this machine, for the brokering refusal. */
  hint?: string
  /** Installs the harness's CLI before the session, when the image doesn't have it baked in. */
  install: boolean
  /** A debug line about the machine's network, after it boots. */
  networkNote?: string
  /** Boots the machine; when it fails, it removes what it made itself. */
  boot(): Promise<BootedMachine>
}

/**
 * The start of a machine sandbox: boot it, start the egress gateway on it, refuse brokered values
 * the gateway can't keep out, install the harness under a deadline of its own, and hand back the
 * sandbox. Anything that fails after the boot removes the machine.
 */
export async function startSandbox(
  options: SandboxOptions,
  start: StartOptions,
): Promise<NetworkSandbox> {
  const { signal } = options
  const glue = gatewayGlue(options)
  const { brokered, debug } = glue
  const machine = await start.boot()
  let gateway: Gateway | undefined
  let destroyed: Promise<void> | undefined
  const destroy = () => {
    destroyed ??= (async () => {
      await gateway?.close()
      await machine.destroy()
    })()
    return destroyed
  }
  try {
    let noGateway: string | undefined
    try {
      gateway = await startGateway(
        machine.root,
        machine.proxyPort === undefined ? glue.egress : { ...glue.egress, port: machine.proxyPort },
        signal,
      )
    } catch (error) {
      if (signal.aborted) throw signal.reason
      noGateway = (error as Error).message
    }
    // Planning refuses a restricted policy on a machine that keeps its own network; were one to
    // get here, nothing would hold the machine to it without the gateway.
    if (
      !gateway &&
      [options.egress, setupEgress(options.egress)].some((e) => isRestricted(e.policy))
    ) {
      throw new InfraError(
        `Can't enforce egress ${egressLabel(options.egress)}: the egress gateway could not start in the ${start.helper} sandbox (${noGateway})`,
      )
    }
    if (start.networkNote) debug?.log('container', start.networkNote)
    logGateway(
      debug,
      gateway ? { active: true } : { active: false, reason: noGateway ?? '' },
      brokered,
    )
    if (!gateway && brokered.length) {
      throw brokeringRefusal(start.helper, brokered, noGateway ?? '', start.hint)
    }
    if (gateway) await machine.onGateway?.(gateway, signal)
    if (signal.aborted) throw signal.reason
    const network = machine.session({ gateway, noGateway, destroy })
    // A machine with nothing baked in downloads pnpm and the CLI here, before the harness's start
    // is timed: there, a slow download would spend its readiness window and be tried again. The
    // eval's timer is paused while a sandbox starts, so the install has a deadline of its own.
    const needed =
      start.install && !machine.installed && options.harness ? harnessBake(options.harness) : null
    const bake = needed && !(await machine.installedElsewhere?.()) ? needed : null
    if (bake) {
      const installing = performance.now()
      const deadline = AbortSignal.timeout(INSTALL_TIMEOUT_MS)
      const stop = AbortSignal.any([signal, deadline])
      const install = installHarness(network, bake, { signal: stop })
      install.catch(() => {})
      const stopped = new Promise<never>((_, reject) => {
        if (stop.aborted) reject(stop.reason)
        stop.addEventListener('abort', () => reject(stop.reason), { once: true })
      })
      stopped.catch(() => {})
      const version = await Promise.race([install, stopped]).catch((error: unknown) => {
        if (signal.aborted) throw error
        throw new InfraError(
          deadline.aborted
            ? `Installing ${bake.name} in ${start.helper} sandbox ${network.id} didn't finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes`
            : `Installing ${bake.name} in ${start.helper} sandbox ${network.id} failed: ${(error as Error).message}`,
        )
      })
      debug?.log(
        'container',
        `installed ${bake.name} ${version} in ${Math.round(performance.now() - installing)}ms`,
      )
      await machine.onInstalled?.()
    }
    return await sessionSandbox(network, glue, {
      ...(machine.stateDir && { stateDir: machine.stateDir }),
      oomKills: async () => null,
      resources: {
        mode: start.darwin ? 'darwin' : 'machine',
        machine: start.machine,
        ...(start.shared && { shared: true }),
      },
    })
  } catch (error) {
    machine.failed?.()
    await destroy().catch(() => {})
    throw error
  }
}
