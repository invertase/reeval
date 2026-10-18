import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The record corpus: real recorded runs every reader is tested against. */
export const CORPUS_DIR = fileURLToPath(new URL('../../test/fixtures/records/', import.meta.url))

const RUN_FILE = /^\d{8}T\d{6}Z_[0-9a-z]+_[0-9a-z-]+_[0-9a-z]{4}\.json$/
/** Where each entry's runs are, from its root: the default `history.dir`. */
export const HISTORY_DIR = 'evals/.history'

export type CorpusRun = {
  runId: string
  file: string
  raw: Record<string, unknown>
  /** Saved analyses in the run's `analysis/` folder. */
  analyses: number
}

export type CorpusEntry = { name: string; dir: string; runs: CorpusRun[] }

/** Each entry of the record corpus, test/fixtures/records/<name>/, with its runs oldest first. */
export function corpusEntries(): CorpusEntry[] {
  const root = CORPUS_DIR
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, HISTORY_DIR)))
    .map((e) => {
      const history = join(root, e.name, HISTORY_DIR)
      const runs = readdirSync(history)
        .filter((n) => RUN_FILE.test(n))
        .sort()
        .map((n) => {
          const runId = n.slice(0, -5)
          const analysis = join(history, runId, 'analysis')
          return {
            runId,
            file: join(history, n),
            raw: JSON.parse(readFileSync(join(history, n), 'utf8')),
            analyses: existsSync(analysis)
              ? readdirSync(analysis).filter((f) => f.endsWith('.json')).length
              : 0,
          }
        })
      return { name: e.name, dir: join(root, e.name), runs }
    })
}

/** Every file of each persisted shape in the corpus. */
export function corpus(): {
  records: Array<{ file: string; value: Record<string, unknown> }>
  transcripts: string[]
  analyses: Array<{ file: string; value: Record<string, unknown> }>
} {
  const records: Array<{ file: string; value: Record<string, unknown> }> = []
  const transcripts: string[] = []
  const analyses: Array<{ file: string; value: Record<string, unknown> }> = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name === 'transcript.jsonl') transcripts.push(path)
      else if (e.name.endsWith('.json') && basename(dir) === 'analysis') {
        analyses.push({ file: path, value: JSON.parse(readFileSync(path, 'utf8')) })
      }
    }
  }
  for (const entry of corpusEntries()) {
    for (const run of entry.runs) records.push({ file: run.file, value: run.raw })
    walk(join(entry.dir, HISTORY_DIR))
  }
  return { records, transcripts, analyses }
}
