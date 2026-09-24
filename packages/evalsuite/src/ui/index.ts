import { AgentRenderer } from './agent.ts'
import { colors } from './colors.ts'
import type { OutputStream, Renderer } from './events.ts'
import type { OutputOptions } from './mode.ts'
import { PlainRenderer } from './plain.ts'
import type { AttemptDir } from './summary.ts'

export type { EsEvent, EvalResult, Progress, Renderer } from './events.ts'
export { formatDuration } from './format.ts'
export { type OutputOptions, resolveOutput } from './mode.ts'

export function createRenderer(options: {
  out: OutputStream
  output: OutputOptions
  harness: string
  attemptDir: AttemptDir
}): Renderer {
  if (options.output.mode === 'agent') return new AgentRenderer(options)
  return new PlainRenderer({ ...options, colors: colors(options.output.color) })
}
