import { redactSecrets } from '../redact.ts'
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
  /** `-v` (1) or `-vv` (2): how debug lines' times read. */
  verbosity?: 0 | 1 | 2
}): Renderer {
  // Progress lines echo check commands and the agent's tool calls, which can hold a secret.
  const out: OutputStream = { write: (text) => options.out.write(redactSecrets(text)) }
  if (options.output.mode === 'agent') return new AgentRenderer({ ...options, out })
  return new PlainRenderer({ ...options, out, colors: colors(options.output.color) })
}
