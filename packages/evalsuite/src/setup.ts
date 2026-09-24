import { extendExpect, holdFileUntilEvalsSettle } from './engine/runtime.ts'
import { matchers } from './matchers.ts'

extendExpect(matchers)
holdFileUntilEvalsSettle()

// Ctrl-C reaches the whole process group. Workers ignore it so the CLI can cancel the run
// and every eval gets to destroy its sandbox.
process.on('SIGINT', () => {})
