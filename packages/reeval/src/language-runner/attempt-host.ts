// Answers attempt-protocol calls from a language runner on the real AttemptContext.
import type { AttemptCall, AttemptReply, AttemptRequest } from '../contract/attempt.ts'
import type { RawAssertion } from '../engine/runtime.ts'
import { expectCall, type ExpectCall } from '../attempt/match.ts'
import type { AttemptContext, BackgroundHandle, JudgeCallOptions, Turn } from '../types.ts'

const isTurnRef = (value: unknown): value is { turn: number } =>
  typeof value === 'object' && value !== null && 'turn' in value

export async function replyToAttempt(
  c: AttemptContext,
  calls: RawAssertion[],
  handles: Map<string, BackgroundHandle>,
  request: AttemptRequest,
): Promise<AttemptReply> {
  const { id, call } = request
  try {
    const body = await perform(c, calls, handles, call)
    return { id, ok: true, op: call.op, ...body } as AttemptReply
  } catch (error) {
    const { name = 'Error', message = String(error) } = error as Error
    return { id, ok: false, op: call.op, error: { name, message } }
  }
}

async function perform(
  c: AttemptContext,
  matcherCalls: RawAssertion[],
  handles: Map<string, BackgroundHandle>,
  call: AttemptCall,
): Promise<Record<string, unknown>> {
  switch (call.op) {
    case 'send': {
      const turn = await c.send(call.prompt)
      const { exec, readFile, ...data } = turn as Turn
      return { turn: data }
    }
    case 'exec': {
      if (call.background) {
        const handle = await c.exec(call.command, { background: true })
        const handleId = `h${handles.size + 1}`
        handles.set(handleId, handle)
        return { result: { handle: handleId } }
      }
      const result = await c.exec(call.command)
      return { result }
    }
    case 'kill':
      await handles.get(call.handle)?.kill()
      return {}
    case 'readFile':
      return { contents: await c.readFile(call.path) }
    case 'writeFile':
      await c.writeFile(
        call.path,
        call.encoding === 'base64' ? Buffer.from(call.contents, 'base64') : call.contents,
      )
      return {}
    case 'expect':
      return { assertion: await expectCall(c, matcherCalls, call as ExpectCall) }
    case 'judge': {
      const { question, options } = call
      const opts = (options ?? {}) as JudgeCallOptions & { on?: unknown }
      const on = opts.on
      const target = isTurnRef(on) ? c.turns[on.turn] : on
      const { on: _drop, ...rest } = opts
      const verdict = await c.judge(question, {
        ...rest,
        ...(on !== undefined ? { on: target as JudgeCallOptions['on'] } : {}),
      })
      return { verdict }
    }
    default:
      throw new Error(`The language runner called ${call.op}, which this reeval doesn't handle yet`)
  }
}
