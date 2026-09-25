import type { Substitution } from '@evalsuite/sandbox-docker'
import type { BrokeredSecret } from '../environment/resolve.ts'
import type { Sandbox } from './types.ts'

export type BrokerPhases = {
  /** Swaps in the agent's brokered secrets: call once, before anything runs in the sandbox. */
  start(): Promise<void>
  /** Runs a check or setup step with the checks' brokered secrets swapped in as well. */
  checks<T>(fn: () => Promise<T>): Promise<T>
}

const strip = ({ phase: _, ...sub }: BrokeredSecret): Substitution => sub

/**
 * Which brokered secrets the gateway swaps in when. `to: 'checks'` secrets are active only while
 * at least one check or setup step is running, so a request the agent makes between them gets
 * the placeholder.
 */
export function brokerPhases(
  box: Pick<Sandbox, 'setSubstitutions'>,
  subs: readonly BrokeredSecret[],
): BrokerPhases {
  const agent = subs.filter((s) => s.phase === 'agent').map(strip)
  const all = subs.map(strip)
  const perPhase = box.setSubstitutions && all.length > agent.length
  let running = 0
  return {
    async start() {
      if (all.length > 0) await box.setSubstitutions?.(agent)
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
