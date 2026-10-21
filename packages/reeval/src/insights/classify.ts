// A classification is cached by its key (`classificationKey`): what it read, the model and the
// prompt version. `.reeval/analysis/classify/<key>.json` is the local cache (gitignored, like the
// rest of `.reeval`), and the latest recorded run's `insights.json` is read back too, so a CI
// checkout with no `.reeval` still skips the call for every eval that hasn't changed.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { analysisCacheDir } from '../analysis/files.ts'
import type { EvalInsight } from '../view/insights.ts'
import { insightsFile, readInsights } from './files.ts'

/** What a classification settles: the eval's intent, less what the facts give. */
export type Classified = Pick<EvalInsight['intent'], 'job' | 'question' | 'subject' | 'name'>

export const classifyDir = (root: string) => join(analysisCacheDir(root), 'classify')

const RUN_FILE = /^\d{8}T\d{6}Z_.+\.json$/

/** The intents of the latest recorded run that has insights, by classification key. */
async function readBack(historyDir: string): Promise<Map<string, Classified>> {
  const runs = (await readdir(historyDir).catch((): string[] => []))
    .filter((n) => RUN_FILE.test(n))
    .map((n) => n.slice(0, -'.json'.length))
    .sort()
    .reverse()
  for (const runId of runs) {
    const doc = await readInsights(insightsFile(historyDir, runId)).catch(() => null)
    if (!doc) continue
    return new Map(
      doc.evals.map(({ intent: { key, job, question, subject, name } }) => [
        key,
        { job, question, subject, name },
      ]),
    )
  }
  return new Map()
}

export type ClassifyCache = {
  get(key: string): Promise<Classified | null>
  set(key: string, value: Classified): Promise<void>
}

/** The cache for a project: its local files first, then the latest recorded run's insights. */
export function classifyCache(root: string, historyDir: string): ClassifyCache {
  const dir = classifyDir(root)
  let recorded: Promise<Map<string, Classified>> | undefined
  return {
    async get(key) {
      const text = await readFile(join(dir, `${key}.json`), 'utf8').catch(() => null)
      if (text !== null) {
        try {
          const value = JSON.parse(text) as Classified
          if (value && typeof value.job === 'string' && typeof value.question === 'string') {
            return value
          }
        } catch {}
      }
      recorded ??= readBack(historyDir)
      return (await recorded).get(key) ?? null
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${key}.json`)
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
      await rename(tmp, path)
    },
  }
}
