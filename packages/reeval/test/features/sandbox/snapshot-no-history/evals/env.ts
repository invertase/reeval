import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** The file as the environment has it, before the eval seeds a bug over it. */
export const seeded = defineEnvironment('seeded', {
  sandbox,
  files: { 'src/sum.js': 'export const sum = (a, b) => a + b // HEALTHY-ORIGINAL\n' },
})

/** What the scripted agent's shell command printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
