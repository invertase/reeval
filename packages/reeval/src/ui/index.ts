import { redactSecrets } from '../redact.ts'
import { AgentRenderer } from './agent.ts'
import { type ColorDepth, colors } from './colors.ts'
import type { OutputStream, Renderer } from './events.ts'
import type { OutputOptions } from './mode.ts'
import { PlainRenderer } from './plain.ts'
import { type InteractiveOptions, InteractiveRenderer } from './tty.ts'

export type { Renderer } from './events.ts'
export { type OutputOptions, resolveOutput } from './mode.ts'

const depthOf = (bits = 4): ColorDepth => (bits >= 24 ? 24 : bits >= 8 ? 8 : 4)

export function createRenderer(options: {
  out: OutputStream
  output: OutputOptions
  harness: string
  /** `-v` (1) or `-vv` (2): how debug lines' times read. */
  verbosity?: 0 | 1 | 2
  /** The terminal's width, for the rich header. */
  columns?: number
  /** The terminal's color depth, as `tty.WriteStream.getColorDepth()` reports it. */
  colorDepth?: number
  /** The terminal the interactive list draws on and reads keys from. */
  tty?: { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream }
  /** The interactive list's run is another process's: see `InteractiveOptions`. */
  attached?: InteractiveOptions['attached']
  /** What the interactive list's cancel keys do. */
  cancel?: InteractiveOptions['cancel']
}): Renderer {
  // Progress lines echo check commands and the agent's tool calls, which can hold a secret.
  const out: OutputStream = { write: (text) => options.out.write(redactSecrets(text)) }
  if (options.output.mode === 'agent') return new AgentRenderer({ ...options, out })
  const paint = colors(options.output.color, depthOf(options.colorDepth))
  if (options.output.interactive && options.tty) {
    return new InteractiveRenderer({ ...options, ...options.tty, out, colors: paint })
  }
  return new PlainRenderer({ ...options, out, colors: paint })
}
