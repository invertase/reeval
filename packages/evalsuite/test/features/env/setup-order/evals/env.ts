import { defineEnvironment } from 'evalsuite'

const base = defineEnvironment('base', { setup: [{ run: 'echo one >> order.txt' }] })

/** An extending environment's steps run after its parent's. */
export const ordered = base.extend('ordered', { setup: [{ run: 'echo two >> order.txt' }] })
