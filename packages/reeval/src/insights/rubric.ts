// The eval rubric, `skills/eval-rubric/SKILL.md`: one section per remark kind, which the insight
// model is given to raise remarks by, and which agents writing evals load as a skill. The build
// copies it from the repository's `skills/` beside `dist/`. Its hash is part of the insights prompt
// version, so insights asked with another rubric read as asked differently.
import { readFileSync } from 'node:fs'
import { sha256 } from '../ids.ts'
import { ownFile } from '../root.ts'

/** Where the rubric ships, in reeval's package. */
export const RUBRIC_FILE = 'skills/eval-rubric/SKILL.md'

let text: string | undefined

/** The rubric's text, read once. */
export const rubric = (): string => {
  text ??= readFileSync(ownFile(RUBRIC_FILE), 'utf8')
  return text
}

/** The kinds the rubric has a section for, in order: each `` ## `kind` `` heading. */
export const rubricKinds = (markdown: string): string[] =>
  [...markdown.matchAll(/^## `([a-z-]+)`\s*$/gm)].map((m) => m[1] as string)

/**
 * The sections of the kinds the model may raise, as the insights call is given them: the rest of
 * the rubric (its gates, reeval's own rules) is enforced in code, so it isn't worth the tokens.
 */
export const modelRubric = (kinds: readonly string[]): string =>
  rubric()
    .split(/^(?=## )/m)
    .filter((section) => kinds.includes(/^## `([a-z-]+)`/.exec(section)?.[1] ?? ''))
    .join('')
    .trim()

/** The first 8 hex characters of the rubric's sha256. */
export const rubricHash = (): string => sha256(rubric()).slice(0, 8)
