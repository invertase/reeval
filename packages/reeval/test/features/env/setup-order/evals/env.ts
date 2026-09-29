import { defineEnvironment } from 'reeval'

const base = defineEnvironment('base', { setup: [{ run: 'echo one >> order.txt' }] })

/** An extending environment's steps run after its parent's. */
export const ordered = base.extendEnvironment('ordered', {
  setup: [{ run: 'echo two >> order.txt' }],
})
