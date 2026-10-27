// The TypeScript reference runner for the context/ scripts. It runs as an eval's body: it hands
// each `runner` request of a script to reeval's attempt host on the attempt `c`, as another
// language's runner's requests reach it, and writes the messages reeval answered with, in order.
// conformance.test.ts copies it into the project it runs, adds what each judge call graded from the
// run record, and compares the result with the script.
import { readFileSync, writeFileSync } from 'node:fs'
import type { AttemptContext } from 'reeval'
import { attemptReply } from 'reeval/testing'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Message = { [key: string]: Json }

export type ScriptRun = {
  script: string
  out: string
  /** The eval file, relative to the project, and its body's id, for `start`. */
  file: string
  body: string
}

export async function runScript(c: AttemptContext, run: ScriptRun): Promise<void> {
  const lines = readFileSync(run.script, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Message)
  const [header] = lines
  const out: Message[] = header ? [header] : []
  out.push({ reeval: { type: 'start', attempt: c.attempt, file: run.file, body: run.body } })
  c.signal.addEventListener(
    'abort',
    () => {
      const reason = c.signal.reason as Error | undefined
      out.push({
        reeval: {
          type: 'abort',
          reason: reason?.name === 'TimeoutError' ? 'timeout' : 'canceled',
          message: reason?.message ?? String(reason),
        },
      })
    },
    { once: true },
  )

  try {
    for (const line of lines.slice(1)) {
      const message = line.runner as Message | undefined
      if (!message) continue
      out.push({ runner: message })
      if (message.type === 'done') {
        const error = message.error as { name: string; message: string } | undefined
        if (error) throw Object.assign(new Error(error.message), { name: error.name })
        break
      }
      const reply = await attemptReply(c, message as Parameters<typeof attemptReply>[1])
      out.push({ reeval: JSON.parse(JSON.stringify(reply)) })
    }
  } finally {
    writeFileSync(run.out, `${out.map((m) => JSON.stringify(m)).join('\n')}\n`)
  }
}
