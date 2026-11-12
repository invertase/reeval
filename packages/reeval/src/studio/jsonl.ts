import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { TranscriptPage, TranscriptRange } from '../view/api.ts'
import { parseTranscriptLine, type TranscriptLine } from '../view/model.ts'

/**
 * `pageTranscript` over a file, read a line at a time: memory holds one line and the page, so a
 * file of any size pages, at the cost of reading it to the end to count its lines.
 */
export async function pageJsonl(file: string, range: TranscriptRange): Promise<TranscriptPage> {
  const end = range.start + range.limit
  const items: TranscriptLine[] = []
  let total = 0
  const input = createReadStream(file)
  try {
    for await (const text of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
      const line = parseTranscriptLine(text)
      if (!line) continue
      if (total >= range.start && total < end) items.push(line)
      total++
    }
  } finally {
    input.destroy()
  }
  return { items, next: end < total ? String(end) : null, totalLines: total }
}
