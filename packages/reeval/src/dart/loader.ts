// A Dart eval file in its worker: the runner declares the file's tree, `declareTree` plans it as
// it would a TypeScript file's, and each attempt's body runs in the runner, whose `t.*` calls are
// answered here on the attempt's real `t`. Leases, the sandbox, the harness, the judge and the
// record stay in reeval.
import { AsyncLocalStorage } from 'node:async_hooks'
import { relative } from 'node:path'
import { declareTree } from '../evaluate.ts'
import { InfraError } from '../sandbox/types.ts'
import type { EvalContext, EvalFn, JudgeCallOptions, Turn } from '../types.ts'
import { prepareDartRunner, type RunnerCommand } from './project.ts'
import type { FromRunner } from './protocol.ts'
import { type DartRunner, errorFrom, startDartRunner } from './runner.ts'

type Live = {
  call(message: Extract<FromRunner, { t: 'call' }>): void
  log(message: Extract<FromRunner, { t: 'log' }>): void
  done(message: Extract<FromRunner, { t: 'done' }>): void
  gone(reason: string): void
}

export async function loadDartFile(file: string, root: string): Promise<void> {
  const command: RunnerCommand = process.env.REEVAL_DART_RUNNER
    ? JSON.parse(process.env.REEVAL_DART_RUNNER)
    : await prepareDartRunner(root, undefined)
  const runner = await startDartRunner(command, root)
  const rel = relative(root, file).replaceAll('\\', '/')
  runner.send({ t: 'collect', file: rel })
  const { tree } = await runner.next('declared')

  const live = new Map<string, Live>()
  runner.onMessage((message) => {
    if (message.t === 'call') live.get(message.attempt)?.call(message)
    else if (message.t === 'log') live.get(message.attempt)?.log(message)
    else if (message.t === 'done') live.get(message.attempt)?.done(message)
  })
  runner.onGone((reason) => {
    for (const attempt of live.values()) attempt.gone(reason)
  })
  let attempts = 0
  declareTree(tree.children, (body) => remoteBody(runner, live, body, () => `r${++attempts}`))
}

const isTurnRef = (value: unknown): value is { $turn: number } =>
  typeof value === 'object' && value !== null && '$turn' in value

/** A `t.*` call from the runner, on the attempt's own `t`. */
async function answer(t: EvalContext, method: string, params: Record<string, unknown>) {
  switch (method) {
    case 'send': {
      const { exec, readFile, ...data } = (await t.send(params.prompt as string)) as Turn
      return data
    }
    case 'exec':
      return t.exec(params.command as string)
    case 'readFile':
      return t.readFile(params.path as string)
    case 'sandbox':
      await t.sandbox()
      return null
    case 'judge': {
      const { question, on, ...options } = params
      const target = isTurnRef(on) ? t.turns[on.$turn] : on
      return t.judge(question as string, {
        ...(options as JudgeCallOptions),
        ...(on !== undefined ? { on: target as JudgeCallOptions['on'] } : {}),
      })
    }
    default:
      throw new Error(`The Dart runner called t.${method}, which this reeval doesn't have`)
  }
}

function remoteBody(
  runner: DartRunner,
  live: Map<string, Live>,
  body: string,
  nextId: () => string,
): EvalFn {
  return (t) =>
    new Promise<void>((resolve, reject) => {
      const attempt = nextId()
      // Errors from `t.*` calls, so a failure the runner reports for one is rethrown as the original
      // (an InfraError stays one in the record).
      const callErrors = new Map<number, unknown>()
      const inAttempt = AsyncLocalStorage.snapshot()
      const finish = (settle: () => void) => {
        live.delete(attempt)
        t.signal.removeEventListener('abort', onAbort)
        settle()
      }
      const onAbort = () => {
        const reason = t.signal.reason
        runner.send({
          t: 'abort',
          attempt,
          reason: reason instanceof Error ? reason.message : String(reason),
        })
        finish(() => reject(reason))
      }
      live.set(attempt, {
        call: ({ id, method, params }) => {
          answer(t, method, params).then(
            (result) => runner.send({ t: 'reply', id, result: result ?? null }),
            (error: unknown) => {
              callErrors.set(id, error)
              const { name = 'Error', message = String(error) } = error as Error
              runner.send({ t: 'reply', id, error: { name, message } })
            },
          )
        },
        log: ({ stream, text }) =>
          inAttempt(() => console[stream === 'stderr' ? 'error' : 'log'](text.replace(/\n$/, ''))),
        done: ({ state, error }) =>
          finish(() => {
            if (state === 'passed') return resolve()
            if (error?.call !== undefined && callErrors.has(error.call)) {
              return reject(callErrors.get(error.call))
            }
            reject(errorFrom(error ?? { name: 'Error', message: 'The Dart eval failed' }))
          }),
        gone: (reason) =>
          finish(() => reject(new InfraError(`The Dart runner stopped mid-attempt: ${reason}`))),
      })
      if (t.signal.aborted) return onAbort()
      t.signal.addEventListener('abort', onAbort, { once: true })
      runner.send({ t: 'run', attempt, body, info: t.attempt })
    })
}
