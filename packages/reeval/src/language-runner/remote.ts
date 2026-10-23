// Out-of-process eval files: declaration tree over the runner session, bodies over attempt protocol v2.
import { AsyncLocalStorage } from 'node:async_hooks'
import { relative } from 'node:path'
import type { AttemptDone } from '../contract/attempt.ts'
import { attemptRecordings } from '../engine/runtime.ts'
import { UsageError } from '../errors.ts'
import { declareTree } from '../evaluate.ts'
import { InfraError } from '../sandbox/types.ts'
import type { BackgroundHandle, EvalFn } from '../types.ts'
import { adapterForFile, runnerEnv } from './adapter.ts'
import { replyToAttempt } from './attempt-host.ts'
import type { RunnerAttemptRequest, RunnerAttemptStart } from './protocol.ts'
import {
  errorFrom,
  isRunnerAttemptDone,
  isRunnerAttemptRequest,
  isSessionFrom,
  type LanguageRunner,
  RunnerLoadError,
  startLanguageRunner,
} from './transport.ts'

type Live = {
  onRequest(message: RunnerAttemptRequest): void
  onLog(message: Extract<import('./protocol.ts').SessionFromRunner, { t: 'log' }>): void
  onDone(message: AttemptDone): void
  gone(reason: string): void
}

const runners = new Map<string, LanguageRunner>()

export async function collectLanguageFile(file: string, root: string): Promise<void> {
  const adapter = adapterForFile(file)
  if (!adapter.remote) throw new Error(`${adapter.id} evals load in-process`)
  const rel = relative(root, file).replaceAll('\\', '/')
  const slot = `${adapter.id}:${root}`
  let runner = runners.get(slot)
  if (!runner) {
    const command = adapter.runnerCommand(root)
    runner = await startLanguageRunner(command, root, runnerEnv(root, adapter)).catch((error) => {
      if (!(error instanceof RunnerLoadError)) throw error
      throw new UsageError(`${error.message}\n${adapter.setupHint}`)
    })
    runners.set(slot, runner)
  }
  const liveRunner = runner
  runner.send({ t: 'collect', file: rel })
  const { tree } = await runner.nextSession('declared')

  const live = new Map<string, Live>()
  runner.onMessage((message) => {
    if (isSessionFrom(message)) {
      if (message.t !== 'log') return
      const owner = message.key === undefined ? undefined : live.get(message.key)
      if (owner) owner.onLog(message)
      else process.stderr.write(`${message.text}\n`)
      return
    }
    if (isRunnerAttemptRequest(message)) {
      const slot = live.get(message.key)
      if (slot) return slot.onRequest(message)
      // A body reeval already settled (aborted, or its runner raced its done) gets an answer, so
      // it can't wait on one forever.
      const error = { name: 'AbortError', message: 'The attempt this call belongs to has ended' }
      liveRunner.send({ id: message.id, ok: false, op: message.call?.op, error, key: message.key })
    } else if (isRunnerAttemptDone(message)) {
      live.get(message.key)?.onDone(message)
    }
  })
  runner.onGone((reason) => {
    for (const attempt of live.values()) attempt.gone(reason)
  })

  declareTree(tree.children, (body) => remoteBody(liveRunner, live, body, rel))
}

let started = 0

function remoteBody(
  runner: LanguageRunner,
  live: Map<string, Live>,
  body: string,
  file: string,
): EvalFn {
  return (t) =>
    new Promise<void>((resolve, reject) => {
      const attemptKey = `${body}:${t.attempt.id}:${++started}`
      const matcherCalls = attemptRecordings()
      const handles = new Map<string, BackgroundHandle>()
      const inAttempt = AsyncLocalStorage.snapshot()
      const finish = (settle: () => void) => {
        live.delete(attemptKey)
        t.signal.removeEventListener('abort', onAbort)
        settle()
      }
      const onAbort = () => {
        const reason = t.signal.reason
        const message =
          reason instanceof Error ? reason.message : String(reason ?? 'The run was cancelled')
        runner.send({
          type: 'abort',
          key: attemptKey,
          reason:
            reason instanceof Error && reason.name === 'TimeoutError' ? 'timeout' : 'cancelled',
          message,
        })
        finish(() => reject(reason))
      }

      live.set(attemptKey, {
        onRequest: (message) => {
          void replyToAttempt(t, matcherCalls, handles, message).then((reply) =>
            runner.send({ ...reply, key: attemptKey }),
          )
        },
        onLog: ({ stream, text }) =>
          inAttempt(() => console[stream === 'stderr' ? 'error' : 'log'](text)),
        onDone: ({ error }) =>
          finish(() => {
            if (!error) return resolve()
            reject(errorFrom(error))
          }),
        gone: (reason) =>
          finish(() =>
            reject(new InfraError(`The language runner stopped mid-attempt: ${reason}`)),
          ),
      })

      if (t.signal.aborted) return onAbort()
      t.signal.addEventListener('abort', onAbort, { once: true })

      const start: RunnerAttemptStart = {
        type: 'start',
        key: attemptKey,
        attempt: t.attempt,
        file,
        body,
      }
      runner.send(start)
    })
}
