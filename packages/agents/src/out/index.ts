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
  /**
   * Also write every stream part to `raw/parts.jsonl`. A turn's parts are held in memory and
   * written when it ends, so a secret split across them can be masked: a process killed mid-turn
   * leaves none of that turn's.
   */
  raw?: boolean
  /** Also write the session's log lines to `debug.log`. */
  debug?: boolean
}

/** A tool output longer than this, in characters, is cut in `transcript.jsonl`. */
export const OUTPUT_CAP = 128 * 1024
const HEAD = 96 * 1024
const TAIL = 16 * 1024

/** Longest first, so a secret that starts another can't leave the longer one's rest behind. */
const longestFirst = (secrets: readonly string[]) =>
  [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length)

/** `text` with each secret value replaced, as it is and as it reads inside a JSON string. */
export function masked(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of longestFirst(secrets)) {
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

/** Where each secret is in `text`, longest first, as non-overlapping `[start, end)` ranges by start. */
function secretRanges(text: string, secrets: readonly string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const secret of secrets) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      const end = at + secret.length
      if (!ranges.some(([s, e]) => at < e && s < end)) ranges.push([at, end])
    }
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

/** The shortest piece of a split secret masked in a turn's other parts: shorter ones read as noise. */
const MIN_FRAGMENT = 4

/**
 * The parts with each secret masked in the text their deltas make together: a model's text splits
 * a key over several deltas, none of which holds the whole of it. The first delta a match starts
 * in gets `[masked]`, and every delta loses the match's characters it held. `fragments` are those
 * characters, each delta's piece of a secret, which an adapter's `raw` part for the same native
 * event repeats, for masking in the turn's other parts.
 */
function maskedDeltas(parts: readonly StampedPart[], secrets: readonly string[]) {
  const fragments = new Set<string>()
  const out = parts.map((p) => ({ ...p, part: { ...p.part } as Record<string, unknown> }))
  const streams = new Map<string, Array<{ part: Record<string, unknown>; field: string }>>()
  for (const { part } of out) {
    const type = String(part.type)
    if (!type.endsWith('-delta')) continue
    const field =
      typeof part.text === 'string' ? 'text' : typeof part.delta === 'string' ? 'delta' : ''
    if (!field) continue
    const key = `${type}\0${String(part.id)}`
    streams.set(key, [...(streams.get(key) ?? []), { part, field }])
  }
  const ordered = longestFirst(secrets)
  for (const deltas of streams.values()) {
    const ranges = secretRanges(deltas.map((d) => d.part[d.field]).join(''), ordered)
    if (!ranges.length) continue
    let offset = 0
    for (const d of deltas) {
      const text = d.part[d.field] as string
      let next = ''
      let piece = ''
      const keep = () => {
        if (piece.length >= MIN_FRAGMENT) fragments.add(piece)
        piece = ''
      }
      for (let i = 0; i < text.length; i++) {
        const at = offset + i
        const range = ranges.find(([s, e]) => at >= s && at < e)
        if (range?.[0] === at) {
          keep()
          next += '[masked]'
        }
        if (range) piece += text[i]
        else {
          keep()
          next += text[i]
        }
      }
      keep()
      d.part[d.field] = next
      offset += text.length
    }
  }
  return { parts: out, fragments: [...fragments] }
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
  readonly #parts = new Map<number, StampedPart[]>()
  #queue: Promise<void> = Promise.resolve()

  private constructor(options: OutOptions, secrets: readonly string[]) {
    this.dir = resolve(options.dir)
    this.#options = options
    this.#secrets = longestFirst(secrets)
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

  #append(file: string, lines: readonly unknown[], also: readonly string[] = []): Promise<void> {
    const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('')
    const secrets = [...this.#secrets, ...also]
    return this.#then(() => appendFile(join(this.dir, file), masked(text, secrets)))
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

  /** Holds a turn's stream part for {@link parts}, which masks a secret split across deltas. */
  part(turn: number, part: StampedPart): void {
    if (!this.#options.raw) return
    this.#parts.set(turn, [...(this.#parts.get(turn) ?? []), part])
  }

  /** Writes the turn's held parts to `raw/parts.jsonl`, once. */
  parts(turn: number): Promise<void> {
    const parts = this.#parts.get(turn)
    if (!parts) return Promise.resolve()
    this.#parts.delete(turn)
    const { parts: deltas, fragments } = maskedDeltas(parts, this.#secrets)
    const lines = deltas.map((p) => ({ turn, ...p }))
    return this.#append('raw/parts.jsonl', lines, fragments)
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
