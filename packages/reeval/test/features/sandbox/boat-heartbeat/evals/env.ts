import { defineEnvironment } from 'reeval'
import { boat } from 'reeval/sandbox/boat'

export const vm = defineEnvironment('vm', { sandbox: boat(), egress: 'allow-all' })

/** Holds the attempt on its machine past a few of the run's 1s heartbeats. */
export const HOLD = 'sleep 3 && echo held'
