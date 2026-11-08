import { defineEnvironment, type Turn } from 'reeval'
import { daytona } from 'reeval/sandbox/daytona'

export const vm = defineEnvironment('vm', {
  sandbox: daytona({
    from: 'debian:bookworm-slim',
    install: ['echo installed > /etc/reeval-install-proof'],
    attemptsPerMachine: 2,
  }),
  egress: 'allow-all',
})

/** What the scripted agent's shell command printed, one entry per line. */
export const agentSaw = (turn: Turn) =>
  turn.transcript
    .flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[0]
    ?.split('\n') ?? []
