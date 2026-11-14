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
   * leaves none of that turn's. That masking is best effort, and the file may hold pieces of a
   * key: in Goose's replaced deltas, in a Cursor event with several text blocks, and wherever a
   * native event's text differs from its deltas'.
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

/**
 * `text`, the stream's characters from `start`, without those in a secret's range: `[masked]`
 * stands where a range starts, and where `text` starts inside one when `open`.
 */
function maskSpan(
  text: string,
  start: number,
  ranges: ReadonlyArray<[number, number]>,
  open: boolean,
) {
  let next = ''
  let r = 0
  for (let i = 0; i < text.length; i++) {
    const at = start + i
    let range = ranges[r]
    while (range && range[1] <= at) range = ranges[++r]
    if (!range || at < range[0]) next += text[i]
    else if (range[0] === at || (open && i === 0)) next += '[masked]'
  }
  return next
}

type DeltaText = {
  text: string
  offset: number
  stream: string
  ranges: Array<[number, number]>
  /** The delta's place among the turn's parts. */
  at: number
}

/** `text` laid over `d`'s stream with `d`'s own text at `at`, masked, if it reads as the stream there. */
function aligned(text: string, d: DeltaText, at: number): string | undefined {
  const start = d.offset - at
  if (start < 0 || d.stream.slice(start, start + text.length) !== text) return undefined
  return maskSpan(text, start, d.ranges, true)
}

/** Of `deltas`, sorted by `at`, the one nearest to the part at `at`. */
function nearest(deltas: readonly [DeltaText, ...DeltaText[]], at: number): DeltaText {
  let lo = 0
  let hi = deltas.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((deltas[mid] as DeltaText).at < at) lo = mid + 1
    else hi = mid
  }
  const after = deltas[lo] as DeltaText
  const before = deltas[lo - 1]
  return before && at - before.at < after.at - at ? before : after
}

type Leaves = {
  /** Every delta of a stream that holds a secret, by its exact text. */
  byText: Map<string, [DeltaText, ...DeltaText[]]>
  /** The deltas since the previous `raw` part. */
  since: readonly DeltaText[]
  /** The `raw` part's place among the turn's parts. */
  at: number
}

/**
 * `value` with each string that repeats stream text masked, where the string, laid over the
 * stream so a delta's text is where the stream has it, reads as the stream. A string that is a
 * delta's text exactly is laid over the nearest such delta in the turn, before or after the
 * `raw` part: an adapter may hold deltas back past the native event they came from. A string
 * that holds a delta, such as the text so far, is matched against the deltas since the previous
 * `raw` part. Object keys, numbers and `type` discriminators are left alone.
 */
function maskLeaves(value: unknown, leaves: Leaves, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'type') return value
    const same = leaves.byText.get(value)
    if (same) return aligned(value, nearest(same, leaves.at), 0) ?? value
    for (const d of leaves.since) {
      for (let at = value.indexOf(d.text); at !== -1; at = value.indexOf(d.text, at + 1)) {
        const masked = aligned(value, d, at)
        if (masked !== undefined) return masked
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map((v) => maskLeaves(v, leaves))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskLeaves(v, leaves, k)]))
  }
  return value
}

/**
 * The parts with each secret masked in the text their deltas make together: a model's text splits
 * a key over several deltas, none of which holds the whole of it. The first delta a match starts
 * in gets `[masked]`, and every delta loses the match's characters it held. Each `raw` part's
 * strings are masked where they repeat that text (`maskLeaves`).
 */
function maskedDeltas(parts: readonly StampedPart[], secrets: readonly string[]) {
  const out = parts.map((p) => ({ ...p, part: { ...p.part } as Record<string, unknown> }))
  const streams = new Map<
    string,
    Array<{ part: Record<string, unknown>; field: string; at: number }>
  >()
  out.forEach(({ part }, at) => {
    const type = String(part.type)
    if (!type.endsWith('-delta')) return
    const field =
      typeof part.text === 'string' ? 'text' : typeof part.delta === 'string' ? 'delta' : ''
    if (!field) return
    const key = `${type}\0${String(part.id)}`
    const deltas = streams.get(key)
    if (deltas) deltas.push({ part, field, at })
    else streams.set(key, [{ part, field, at }])
  })
  const ordered = longestFirst(secrets)
  const texts = new Map<Record<string, unknown>, DeltaText>()
  const byText = new Map<string, [DeltaText, ...DeltaText[]]>()
  for (const deltas of streams.values()) {
    const stream = deltas.map((d) => d.part[d.field]).join('')
    const ranges = secretRanges(stream, ordered)
    if (!ranges.length) continue
    let offset = 0
    for (const d of deltas) {
      const text = d.part[d.field] as string
      if (text) texts.set(d.part, { text, offset, stream, ranges, at: d.at })
      d.part[d.field] = maskSpan(text, offset, ranges, false)
      offset += text.length
    }
  }
  if (!texts.size) return out
  for (const d of [...texts.values()].sort((a, b) => a.at - b.at)) {
    const same = byText.get(d.text)
    if (same) same.push(d)
    else byText.set(d.text, [d])
  }
  let since: DeltaText[] = []
  out.forEach(({ part }, at) => {
    const text = texts.get(part)
    if (text) since.push(text)
    if (part.type !== 'raw') return
    part.rawValue = maskLeaves(part.rawValue, { byText, since, at })
    since = []
  })
  return out
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

  /** Holds a turn's stream part for {@link parts}, which masks a secret split across deltas. */
  part(turn: number, part: StampedPart): void {
    if (!this.#options.raw) return
    const parts = this.#parts.get(turn)
    if (parts) parts.push(part)
    else this.#parts.set(turn, [part])
  }

  /** Writes the turn's held parts to `raw/parts.jsonl`, once. */
  parts(turn: number): Promise<void> {
    const parts = this.#parts.get(turn)
    if (!parts) return Promise.resolve()
    this.#parts.delete(turn)
    const lines = maskedDeltas(parts, this.#secrets).map((p) => ({ turn, ...p }))
    return this.#append('raw/parts.jsonl', lines)
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
