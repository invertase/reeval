import type { HarnessV1, HarnessV1StreamPart } from '@ai-sdk/harness'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { observed, tokenUsage } from '../../src/harness/agent.ts'
import { errorText, type StampedPart } from '../../src/harness/transcript.ts'

/**
 * A harness that emits `parts` for every turn, through a real HarnessAgent, as reeval drives it.
 * `stream` is the agent's `fullStream`, stamped as reeval stamps it for `normalizeStream`, and
 * `error` what the turn failed with, as reeval catches it.
 */
export async function turnThrough(
  parts: HarnessV1StreamPart[],
  builtinTools: HarnessV1['builtinTools'] = {},
) {
  let served: string | undefined
  const adapter: HarnessV1 = {
    specificationVersion: 'harness-v1',
    harnessId: 'scripted',
    builtinTools,
    doStart: async ({ sessionId }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async (turn) => {
        for (const part of parts) turn.emit(part)
        return { submitToolResult: async () => {}, done: Promise.resolve() }
      },
      doCompact: async () => {},
      doContinueTurn: async () => ({ submitToolResult: async () => {}, done: Promise.resolve() }),
      doSuspendTurn: async () => ({}) as never,
      doDetach: async () => ({}) as never,
      doStop: async () => ({}) as never,
      doDestroy: async () => {},
    }),
  } as HarnessV1
  const agent = new HarnessAgent({
    harness: observed(adapter, (part) => {
      if (part.type === 'stream-start' && part.modelId) served = part.modelId
    }),
    model: 'requested-model',
    permissionMode: 'allow-all',
  })
  const sandboxSession = {
    description: 'none',
    defaultWorkingDirectory: '/reeval',
    run: async () => ({ exitCode: 0, stdout: '/root', stderr: '' }),
    restricted: () => sandboxSession,
  }
  const session = await agent.createSession({ sandboxSession: sandboxSession as never })
  const result = await agent.stream({ session, prompt: 'go' })
  const stream: StampedPart[] = []
  for await (const part of result.fullStream) {
    stream.push({ ms: stream.length, part: part as StampedPart['part'] })
  }
  try {
    return {
      usage: tokenUsage(await result.totalUsage),
      served,
      stream,
      text: await result.text,
      error: null,
    }
  } catch (error) {
    // A harness's `error` part fails the turn, as it fails reeval's; `stream` has it.
    return { usage: null, served, stream, text: null, error: errorText(error) }
  }
}
