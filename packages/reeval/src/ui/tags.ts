import type { CollectedEval } from './events.ts'

const STOPWORDS = new Set(
  'a an the and or of to in on for with without from by at as is are be it its that this when than then into via not no'.split(
    ' ',
  ),
)
const MAX_WORDS = 3
const MAX_LENGTH = 24

const words = (name: string) =>
  name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOPWORDS.has(w))

/**
 * Short handles for the evals of one file, e.g. `greet`: the first distinctive words of each
 * name, where words shared by most of the file's evals ("recommends Genkit over …") don't
 * count. Depends only on the file's evals, so a tag stays the same across runs and filters.
 */
function fileTags(
  evals: Array<Pick<CollectedEval, 'id' | 'name'>>,
  taken: Set<string>,
): Map<string, string> {
  const lists = evals.map((e) => words(e.name))
  const df = new Map<string, number>()
  for (const list of lists) for (const w of new Set(list)) df.set(w, (df.get(w) ?? 0) + 1)
  const common = (w: string) => evals.length > 1 && (df.get(w) ?? 0) > evals.length / 2
  const candidates = lists.map((list) => {
    const rare = list.filter((w) => !common(w))
    return rare.length ? rare : list.length ? list : ['eval']
  })
  const tags = new Map<string, string>()
  const clip = (tag: string) => tag.slice(0, MAX_LENGTH).replace(/-+$/, '')
  const prefix = (list: string[], n: number) => clip(list.slice(0, n).join('-'))
  evals.forEach((e, i) => {
    const own = candidates[i] ?? ['eval']
    let tag = prefix(own, 1)
    for (let n = 1; n <= MAX_WORDS; n++) {
      tag = prefix(own, n)
      const clash = candidates.some((other, j) => j !== i && prefix(other, n) === tag)
      if (!clash && !taken.has(tag)) break
    }
    let unique = tag
    for (let k = 2; taken.has(unique); k++) unique = `${tag}-${k}`
    taken.add(unique)
    tags.set(e.id, unique)
  })
  return tags
}

/** Tags evals as their files are collected; later files never rename earlier tags. */
export class Tagger {
  #tags = new Map<string, string>()
  #taken = new Set<string>()

  addFile(attempts: Array<Pick<CollectedEval, 'id' | 'name'>>): void {
    const evals = [...new Map(attempts.map((a) => [a.id, a])).values()]
    const fresh = evals.filter((e) => !this.#tags.has(e.id))
    for (const [id, tag] of fileTags(fresh, this.#taken)) this.#tags.set(id, tag)
  }

  /** `greet#1`: the eval's tag and run number. */
  label(id: string, attempt: number): string {
    let tag = this.#tags.get(id)
    if (!tag) {
      this.addFile([{ id, name: id.split(' › ').at(-1) ?? id }])
      tag = this.#tags.get(id) ?? 'eval'
    }
    return `${tag}#${attempt}`
  }
}
