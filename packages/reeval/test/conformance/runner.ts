// The TypeScript reference runner for the context/ scripts. It runs as an eval's body: it makes
// each `runner` request of a script on the attempt `c`, as another language's runner would ask
// reeval to, and writes the messages reeval answered with, in order. conformance.test.ts copies it
// into the project it runs, fills in each expect's assertion record from the run record, and
// compares the result with the script.
import { readFileSync, writeFileSync } from 'node:fs'
import type { AttemptContext, BackgroundHandle } from 'reeval'
import { expect } from 'reeval'
import { recordCheck } from 'reeval/testing'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Message = { [key: string]: Json }
type Call = { op: string; [key: string]: Json }
type Subject =
  | { turn: number }
  | { attempt: true }
  | { value: Json }
  | { exec: string; result?: Json }
  | {
      readFile: string
    }

export type ScriptRun = {
  script: string
  out: string
  /** The eval file, relative to the project, and its body's id, for `start`. */
  file: string
  body: string
}

/** What a check's default label names its subject by, as `c.exec`'s promise names its command. */
const NAMED_BY = Symbol.for('reeval.subject')

const isPattern = (arg: Json): arg is { regexp: string; flags?: string } =>
  typeof arg === 'object' && arg !== null && !Array.isArray(arg) && 'regexp' in arg

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
          reason: reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled',
          message: reason?.message ?? String(reason),
        },
      })
    },
    { once: true },
  )
  const handles = new Map<string, BackgroundHandle>()
  let assertions = 0

  const turnAt = (index: number) => {
    const turn = c.turns[index]
    if (!turn) throw new RangeError(`There's no turn ${index}: the attempt has ${c.turns.length}`)
    return turn
  }

  function reader(subject: Subject): () => unknown {
    if ('turn' in subject) return () => turnAt(subject.turn)
    if ('attempt' in subject) return () => c
    if ('exec' in subject && subject.result) {
      const { result, exec } = subject
      return () => Object.defineProperty(Promise.resolve(result), NAMED_BY, { value: exec })
    }
    if ('exec' in subject) return () => c.exec(subject.exec)
    if ('readFile' in subject) return () => c.readFile(subject.readFile)
    return () => subject.value
  }

  async function expectCall(call: Call): Promise<Message> {
    const subject = call.subject as Subject
    const args = (call.args as Json[]).map((arg) =>
      isPattern(arg) ? new RegExp(arg.regexp, arg.flags) : arg,
    )
    const label = typeof call.label === 'string' ? call.label : undefined
    let assertion: Record<string, unknown>
    if (call.poll) {
      const poll = call.poll as { interval?: number; timeout?: number }
      assertion = expect.poll(reader(subject), { ...poll, ...(label ? { message: label } : {}) })
    } else {
      // A command's promise names it in toSucceed's default label, as `expect(c.exec(…))` does.
      const read = reader(subject)
      const value = 'exec' in subject && call.matcher === 'toSucceed' ? read() : await read()
      assertion = (call.soft ? expect.soft : expect)(value, label)
    }
    if (call.not) assertion = assertion.not as Record<string, unknown>
    const matcher = assertion[call.matcher as string] as (...args: unknown[]) => unknown
    const index = assertions++
    try {
      await matcher(...args)
    } catch {
      // A failed matcher is a result: its record says so.
    }
    return { assertion: index }
  }

  async function perform(call: Call): Promise<Message> {
    switch (call.op) {
      case 'send':
        return { turn: JSON.parse(JSON.stringify(await c.send(call.prompt as string))) }
      case 'exec': {
        if (call.background) {
          const handle = await c.exec(call.command as string, { background: true })
          const id = `h${handles.size + 1}`
          handles.set(id, handle)
          return { result: { handle: id } }
        }
        const { exitCode, stdout, stderr } = await c.exec(call.command as string, {
          ...(call.retries === undefined ? {} : { retries: call.retries as number }),
          ...(call.interval === undefined ? {} : { interval: call.interval as number }),
        })
        return { result: { exitCode, stdout, stderr } }
      }
      case 'kill':
        await handles.get(call.handle as string)?.kill()
        return {}
      case 'readFile':
        return { contents: await c.readFile(call.path as string) }
      case 'writeFile': {
        const contents = call.contents as string
        await c.writeFile(
          call.path as string,
          call.encoding === 'base64' ? Buffer.from(contents, 'base64') : contents,
        )
        return {}
      }
      case 'expect':
        return expectCall(call)
      case 'record': {
        const { op, ...check } = call
        assertions++
        return { assertion: recordCheck(check as Parameters<typeof recordCheck>[0]) }
      }
      case 'judge': {
        const { on, ...options } = (call.options ?? {}) as { on?: Subject; [key: string]: Json }
        const graded = on === undefined ? {} : { on: reader(on)() as Json }
        const verdict = await c.judge(call.question as string, { ...options, ...graded } as never)
        return { verdict: JSON.parse(JSON.stringify(verdict)) }
      }
      default:
        throw new TypeError(`The reference runner doesn't make ${call.op} calls`)
    }
  }

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
      const { id } = message
      const call = message.call as Call
      try {
        out.push({ reeval: { id, ok: true, op: call.op, ...(await perform(call)) } })
      } catch (error) {
        const { name, message: text } = error as Error
        out.push({ reeval: { id, ok: false, op: call.op, error: { name, message: text } } })
      }
    }
  } finally {
    writeFileSync(run.out, `${out.map((m) => JSON.stringify(m)).join('\n')}\n`)
  }
}
