import { defineEnvironment } from 'reeval'
import { daytona } from 'reeval/sandbox/daytona'

export const vm = defineEnvironment('vm', { sandbox: daytona(), egress: 'allow-all' })

/** Keeps one CPU busy for three seconds, then prints how many CPUs the VM has. */
export const BURN = `node -e 'const t = Date.now(); while (Date.now() - t < 3000); console.log(require("os").cpus().length)'`
