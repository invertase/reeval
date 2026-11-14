import { createHash } from 'node:crypto'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StampedPart } from '../driver/transcript.ts'
import type { HarnessResult } from '../driver/types.ts'
import type { TranscriptEvent } from '../types.ts'
import type { OutSession, OutTranscriptLine, OutTurn } from './types.ts'

/** Where a session writes what it did, on the host. */
export type OutOptions = {
  dir: string
  /** Also write every stream part to `raw/parts.jsonl`. */
  raw?: boolean
  /** Also write the session's log lines to `debug.log`. */
  debug?: boolean
}

/** A tool output longer than this, in characters, is cut in `transcript.jsonl`. */
export const OUTPUT_CAP = 128 * 1024
const HEAD = 96 * 1024
const TAIL = 16 * 1024

/** `text` with each secret value replaced, as it is and as it reads inside a JSON string. */
export function masked(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      out = out.replaceAll(form, '[masked]')
    }
  }
  return out
}

function capped(text: string): string {
  if (text.length <= OUTPUT_CAP) return text
  const omitted = text.length - HEAD - TAIL
  const sha = createHash('sha256').update(text).digest('hex')
  return `${text.slice(0, HEAD)}\n[truncated ${omitted} of ${text.length} characters, sha256 ${sha}]\n${text.slice(-TAIL)}`
}

/** The transcript event as `transcript.jsonl` has it: a tool's long output cut to its ends. */
function line(turn: number, event: TranscriptEvent, secrets: readonly string[]): OutTranscriptLine {
  if (event.type !== 'tool') return { turn, ...event }
  const raw =
    typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2)
  if (raw === undefined || raw.length <= OUTPUT_CAP) return { turn, ...event }
  const text = masked(raw, secrets)
  const bytes = Math.max(event.outputTruncated?.bytes ?? 0, Buffer.byteLength(text))
  return { turn, ...event, output: capped(text), outputTruncated: { bytes } }
}

/**
 * Writes a session's `out` directory: `session.json`, then a line of `turns.jsonl` and the turn's
 * lines of `transcript.jsonl` as each turn ends, so a directory a crash left behind still reads.
 * Every file has the secrets masked. Writes run in order, one at a time.
 */
export class OutWriter {
  readonly dir: string
  readonly #options: OutOptions
  readonly #secrets: readonly string[]
  #queue: Promise<void> = Promise.resolve()

  private constructor(options: OutOptions, secrets: readonly string[]) {
    this.dir = resolve(options.dir)
    this.#options = options
    this.#secrets = secrets.filter((s) => s.length > 0)
  }

  static async open(options: OutOptions, secrets: readonly string[]): Promise<OutWriter> {
    const out = new OutWriter(options, secrets)
    await mkdir(options.raw ? join(out.dir, 'raw') : out.dir, { recursive: true })
    for (const file of ['turns.jsonl', 'transcript.jsonl']) await writeFile(join(out.dir, file), '')
    if (options.raw) await writeFile(join(out.dir, 'raw', 'parts.jsonl'), '')
    if (options.debug) await writeFile(join(out.dir, 'debug.log'), '')
    return out
  }

  #then(write: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(write)
    this.#queue = next.catch(() => {})
    return next
  }

  #append(file: string, lines: readonly unknown[]): Promise<void> {
    const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('')
    return this.#then(() => appendFile(join(this.dir, file), masked(text, this.#secrets)))
  }

  session(doc: OutSession): Promise<void> {
    const file = join(this.dir, 'session.json')
    const text = masked(`${JSON.stringify(doc, null, 2)}\n`, this.#secrets)
    return this.#then(async () => {
      await writeFile(`${file}.tmp`, text)
      await rename(`${file}.tmp`, file)
    })
  }

  async turn(turn: number, prompt: string, result: HarnessResult): Promise<void> {
    const { transcript, raw: _raw, steps: _steps, ...rest } = result
    const record: OutTurn = { turn, prompt, ...rest }
    await this.#append(
      'transcript.jsonl',
      transcript.map((e) => line(turn, e, this.#secrets)),
    )
    await this.#append('turns.jsonl', [record])
  }

  part(turn: number, part: StampedPart): Promise<void> {
    if (!this.#options.raw) return Promise.resolve()
    return this.#append('raw/parts.jsonl', [{ turn, ...part }])
  }

  log(text: string): Promise<void> {
    if (!this.#options.debug) return Promise.resolve()
    const entry = `${new Date().toISOString()} ${text}\n`
    return this.#then(() => appendFile(join(this.dir, 'debug.log'), masked(entry, this.#secrets)))
  }

  /** Waits for every write so far. */
  flush(): Promise<void> {
    return this.#queue
  }
}
