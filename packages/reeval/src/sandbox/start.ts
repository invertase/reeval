import {
  type DockerSession,
  type EgressStatus,
  type ExecTransport,
  type Gateway,
  startGateway,
} from '@reeval/sandbox-docker'
import type { AttemptDebug } from '../debug/attempt.ts'
import { gatewayGlue, sessionSandbox } from './docker.ts'
import type { SandboxOptions } from './index.ts'
import { harnessBake, installHarness } from './tart-bake.ts'
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
  /** Removes the machine. */
  destroy(): Promise<void>
}

export type StartOptions = {
  /** How messages name the sandbox: `boat()`, `tart()`. */
  helper: string
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
      gateway = await startGateway(machine.root, glue.egress, signal)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      noGateway = (error as Error).message
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
    const bake = start.install && options.harness && harnessBake(options.harness)
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
    }
    return await sessionSandbox(network, glue, {
      ...(machine.stateDir && { stateDir: machine.stateDir }),
      oomKills: async () => null,
    })
  } catch (error) {
    await destroy().catch(() => {})
    throw error
  }
}
