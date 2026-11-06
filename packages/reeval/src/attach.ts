// `reeval attach`: follows a run's event stream and draws it with the renderer `reeval run` would,
// from the stream's first line, so attaching mid-run replays what already happened and then
// follows. It exits with the run's own exit code.
import { EventStreamError, type FollowOptions, followEvents } from './events.ts'
import type { OutputStream, Renderer } from './ui/events.ts'
import { createRenderer, type OutputOptions } from './ui/index.ts'

export type AttachOptions = {
  /** A stream file or URL. */
  source: string
  out: OutputStream
  /** How to print, given the run's `-v` level (`-v` defaults `--output-logs` to full). */
  output: (verbosity: 0 | 1 | 2) => OutputOptions
  columns?: number
  colorDepth?: number
  follow?: FollowOptions
}

/** Draws the stream until the run's last exit line, and returns its exit code. */
export async function attach(options: AttachOptions): Promise<number> {
  let renderer: Renderer | undefined
  let code: number | undefined
  try {
    for await (const line of followEvents(options.source, options.follow)) {
      if (line.type === 'header') {
        // A resume of the run starts its own output, as its terminal did.
        renderer?.close()
        code = undefined
        renderer = createRenderer({
          out: options.out,
          output: { ...options.output(line.verbosity), interactive: false },
          harness: line.harness,
          verbosity: line.verbosity,
          ...(options.columns === undefined ? {} : { columns: options.columns }),
          ...(options.colorDepth === undefined ? {} : { colorDepth: options.colorDepth }),
        })
        continue
      }
      if (line.type === 'exit') {
        renderer?.close()
        renderer = undefined
        code = line.code
        continue
      }
      renderer?.onEvent(line)
    }
  } finally {
    renderer?.close()
  }
  if (code === undefined) {
    throw new EventStreamError(`the event stream at ${options.source} ended before the run did`)
  }
  return code
}
