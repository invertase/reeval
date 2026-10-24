// The harnesses these evals use, defined once so the config, evals and profile limits share them.
import { cursor, pi } from 'reeval/harness'

export const composer = cursor({ model: 'composer-2.5' }) // id cursor:composer-2.5
export const pim = pi({ model: 'gemini-3.8-flash' }) // id pi:gemini-3.8-flash
