import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { testDir } from './fixture.ts'

/** Every run record, and each transcript.jsonl, under the corpus in test/fixtures/records/. */
export function corpus(): {
  records: Array<{ file: string; value: Record<string, unknown> }>
  transcripts: string[]
} {
  const records: Array<{ file: string; value: Record<string, unknown> }> = []
  const transcripts: string[] = []
  const walk = (dir: string, history: boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path, history || e.name === '.history')
      else if (history && e.name.endsWith('.json') && /^\d{8}T\d{6}Z_/.test(e.name)) {
        records.push({ file: path, value: JSON.parse(readFileSync(path, 'utf8')) })
      } else if (e.name === 'transcript.jsonl') transcripts.push(path)
    }
  }
  walk(join(testDir, 'fixtures/records'), false)
  return { records, transcripts }
}
