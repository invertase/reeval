// dist/worker.js: the process the main process forks for each eval file (./worker.ts).
import { startWorker } from './worker.ts'

// Workers run in their own process group, but a stray Ctrl-C must still leave cancelling to the CLI.
process.on('SIGINT', () => {})
const worker = startWorker({
  send: (message, sent) => process.send?.(message, undefined, {}, () => sent?.()),
  onMessage: (listener) => process.on('message', listener),
  onDisconnect: (listener) => process.on('disconnect', listener),
  exit: (code) => process.exit(code),
})
process.on('unhandledRejection', (error) => worker.unhandled(error))
process.on('uncaughtException', (error) => worker.unhandled(error))
