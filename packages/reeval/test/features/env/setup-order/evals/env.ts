import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const base = defineEnvironment('base', {
  sandbox,
  setup: [{ run: 'echo one >> order.txt' }],
})

/** An extending environment's steps run after its parent's. */
export const ordered = base.extendEnvironment('ordered', {
  setup: [{ run: 'echo two >> order.txt' }],
})
