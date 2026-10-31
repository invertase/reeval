// Answers attempt-protocol calls from a language runner on the real AttemptContext.

import { type ExpectCall, expectCall, recordCall } from '../attempt/match.ts'
import {
  type AttemptCall,
  type AttemptReply,
  type AttemptRequest,
  attemptRequestProblem,
  type JudgeOn,
} from '../contract/attempt.ts'
import type { RawAssertion } from '../engine/runtime.ts'
import { UsageError } from '../errors.ts'
import type {
  AttemptContext,
  BackgroundHandle,
  JudgeCallFields,
  JudgeCallOptions,
  Turn,
} from '../types.ts'

/** The turn or value a wire `JudgeOn` names, as `c.judge`'s own `on` takes it. */
function judgeTarget(c: AttemptContext, on: JudgeOn): JudgeCallFields['on'] {
  if ('value' in on) return on.value
  const turn = c.turns[on.turn]
  if (!turn) {
    const n = c.turns.length
    throw new UsageError(
      `c.judge()'s on is turn ${on.turn}, but the attempt has ${n} turn${n === 1 ? '' : 's'}`,
    )
  }
  return turn
}

export async function replyToAttempt(
  c: AttemptContext,
  calls: RawAssertion[],
  handles: Map<string, BackgroundHandle>,
  request: AttemptRequest,
): Promise<AttemptReply> {
  const { id, call } = request
  let problem: string | undefined
  try {
    problem = attemptRequestProblem({ id, call })
  } catch (error) {
    // A value nested deep enough exhausts the stack while it's checked.
    problem = `The attempt request couldn't be checked: ${(error as Error).message}`
  }
  if (problem) {
    const error = { name: 'UsageError', message: problem }
    return { id, ok: false, op: call?.op, error } as AttemptReply
  }
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
      const { retries, interval } = call
      const result = await c.exec(call.command, {
        ...(retries === undefined ? {} : { retries }),
        ...(interval === undefined ? {} : { interval }),
      })
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
    case 'observe':
      c.observe(call.name, call.value)
      return {}
    case 'expect':
      return await expectCall(c, matcherCalls, call as ExpectCall)
    case 'record':
      return { assertion: recordCall(matcherCalls, call) }
    case 'judge': {
      const { question, options } = call
      const { on, ...rest } = (options ?? {}) as Omit<JudgeCallFields, 'on'> & { on?: JudgeOn }
      const verdict = await c.judge(question, {
        ...rest,
        ...(on === undefined ? {} : { on: judgeTarget(c, on) }),
      } as JudgeCallOptions)
      return { verdict }
    }
    default:
      throw new Error(`The language runner called ${call.op}, which this reeval doesn't handle yet`)
  }
}
