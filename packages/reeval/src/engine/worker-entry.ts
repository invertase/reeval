// `reeval __worker`: the process the main process starts for each eval file (./pool.ts, ./worker.ts).
import { startWorker } from './worker.ts'

if (!process.send) {
  console.error(
    "reeval __worker is the process reeval starts for each eval file; it isn't a command.",
  )
  process.exit(2)
}
// Workers run in their own process group, but a stray Ctrl-C must still leave cancelling to the CLI.
process.on('SIGINT', () => {})
const worker = startWorker({
  // With a callback, a send after the main process went away isn't an uncaught 'error'.
  send: (message) => process.send?.(message, undefined, {}, () => {}),
  onMessage: (listener) => process.on('message', listener),
  onDisconnect: (listener) => process.on('disconnect', listener),
  exit: (code) => process.exit(code),
})
process.on('unhandledRejection', (error) => worker.unhandled(error))
process.on('uncaughtException', (error) => worker.unhandled(error))
