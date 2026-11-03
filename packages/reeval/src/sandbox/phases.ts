import type { Substitution } from '@reeval/sandbox-docker'
import { debugLog } from '../debug/attempt.ts'
import { gatewayPolicy, isDirect, phaseLabel } from '../egress.ts'
import type { BrokeredSecret } from '../environment/resolve.ts'
import type { PlannedEgress, PlannedPhaseEgress } from '../types.ts'
import { InfraError, type Sandbox } from './types.ts'

export type BrokerPhases = {
  /**
   * Swaps in the agent's brokered secrets and, with a setup policy of its own, starts the setup
   * phase under it: call once, before anything runs in the sandbox.
   */
  start(): Promise<void>
  /** With a setup policy of its own, switches to the agent's: call once, after the setup steps. */
  agent(): Promise<void>
  /** Runs a check or setup step with the checks' brokered secrets swapped in as well. */
  checks<T>(fn: () => Promise<T>): Promise<T>
}

const strip = ({ phase: _, ...sub }: BrokeredSecret): Substitution => sub

/**
 * Which brokered secrets the gateway swaps in when, and which egress policy it enforces when.
 * `to: 'checks'` secrets are active only while at least one check or setup step is running, so a
 * request the agent makes between them gets the placeholder. A setup policy of its own holds from
 * the sandbox's start until `agent()`; every check runs under the agent's.
 */
export function brokerPhases(
  box: Pick<Sandbox, 'setSubstitutions' | 'setEgress'>,
  subs: readonly BrokeredSecret[],
  egress?: PlannedEgress,
): BrokerPhases {
  const agent = subs.filter((s) => s.phase === 'agent').map(strip)
  const all = subs.map(strip)
  const perPhase = box.setSubstitutions && all.length > agent.length
  let running = 0
  const enter = async (phase: 'setup' | 'agent', planned: PlannedPhaseEgress) => {
    if (!box.setEgress) {
      throw new InfraError(
        `Can't switch the sandbox's egress between the setup and agent phases: its egress gateway isn't running`,
      )
    }
    debugLog('container', `egress → ${phase}: ${phaseLabel(planned) || 'proxy'}`)
    await box.setEgress({
      policy: gatewayPolicy(planned),
      direct: isDirect(planned.policy),
      phase,
    })
  }
  return {
    async start() {
      if (all.length > 0) await box.setSubstitutions?.(agent)
      if (egress?.setup) await enter('setup', egress.setup)
    },
    async agent() {
      if (egress?.setup) await enter('agent', egress)
    },
    async checks(fn) {
      if (!perPhase) return fn()
      if (running === 0) await box.setSubstitutions?.(all)
      running++
      try {
        return await fn()
      } finally {
        if (--running === 0) await box.setSubstitutions?.(agent)
      }
    },
  }
}
