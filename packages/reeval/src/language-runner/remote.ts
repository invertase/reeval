// Out-of-process eval files: declaration tree over the runner session, bodies over attempt protocol v2.
import { AsyncLocalStorage } from 'node:async_hooks'
import { relative } from 'node:path'
import type { AttemptDone, AttemptStart } from '../contract/attempt.ts'
import type { RawAssertion } from '../engine/runtime.ts'
import { declareTree } from '../evaluate.ts'
import { InfraError } from '../sandbox/types.ts'
import type { AttemptContext, BackgroundHandle, EvalFn } from '../types.ts'
import { adapterForFile, runnerEnv } from './adapter.ts'
import { replyToAttempt } from './attempt-host.ts'
import type { RunnerAttemptDone, RunnerAttemptRequest } from './protocol.ts'
import {
  errorFrom,
  isRunnerAttemptDone,
  isRunnerAttemptRequest,
  isSessionFrom,
  type LanguageRunner,
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
  let runner = runners.get(root)
  if (!runner) {
    const command = adapter.runnerCommand(root)
    runner = await startLanguageRunner(command, root, runnerEnv(root, adapter))
    runners.set(root, runner)
  }
  const liveRunner = runner
  runner.send({ t: 'collect', file: rel })
  const { tree } = await runner.nextSession('declared')

  const live = new Map<string, Live>()
  runner.onMessage((message) => {
    if (isSessionFrom(message)) {
      if (message.t === 'log') {
        for (const attempt of live.values()) attempt.onLog(message)
      }
      return
    }
    if (isRunnerAttemptRequest(message)) {
      const slot = live.get(message.attempt)
      slot?.onRequest(message)
    } else if (isRunnerAttemptDone(message)) {
      const key = (message as RunnerAttemptDone).attempt
      if (key) live.get(key)?.onDone(message)
      else if (live.size === 1) live.values().next().value?.onDone(message)
    }
  })
  runner.onGone((reason) => {
    for (const attempt of live.values()) attempt.gone(reason)
  })

  declareTree(tree.children, (body) => remoteBody(liveRunner, live, body, rel))
}

function remoteBody(
  runner: LanguageRunner,
  live: Map<string, Live>,
  body: string,
  file: string,
): EvalFn {
  return (t) =>
    new Promise<void>((resolve, reject) => {
      const attemptKey = t.attempt.id
      const matcherCalls: RawAssertion[] = []
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
          reason:
            reason instanceof Error && reason.name === 'TimeoutError' ? 'timeout' : 'cancelled',
          message,
        })
        finish(() => reject(reason))
      }

      live.set(attemptKey, {
        onRequest: (message) => {
          void replyToAttempt(t, matcherCalls, handles, message).then((reply) =>
            runner.send({ ...reply, attempt: attemptKey }),
          )
        },
        onLog: ({ stream, text }) =>
          inAttempt(() => console[stream === 'stderr' ? 'error' : 'log'](text.replace(/\n$/, ''))),
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

      const start: AttemptStart = {
        type: 'start',
        attempt: t.attempt,
        file,
        body,
      }
      runner.send(start)
    })
}
