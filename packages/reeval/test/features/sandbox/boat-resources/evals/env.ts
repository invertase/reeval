import { defineEnvironment } from 'reeval'
import { boat } from 'reeval/sandbox/boat'

export const vm = defineEnvironment('vm', { sandbox: boat(), egress: 'allow-all' })

/** Keeps one CPU busy for three seconds, then prints how many CPUs the VM has. */
export const BURN = `node -e 'const t = Date.now(); while (Date.now() - t < 3000); console.log(require("os").cpus().length)'`
