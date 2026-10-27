// Holds the Compare harnesses recipe to the code behind its effort claims, so a page that reads
// medians as a win or promises columns its query omits fails `pnpm docs:check` instead of waiting
// for a judge.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'docs/recipes/agent-comparison.mdx'

/** The text outside code fences, with the frontmatter description kept as a sentence. */
const prose = (text) =>
  text
    .replace(/^---\n([\s\S]*?)\n---\n/, (_, front) => `${front.split('\n').join('. ')}.\n`)
    .replace(/```[\s\S]*?```/g, '')

/**
 * Problems in the recipe's text:
 *  - it says fewer tool calls and seconds mean less work and never mentions the significance test,
 *    which effort.ts applies before it calls a difference `fewer` or `more`;
 *  - its outcome names tokens while its `effort` query doesn't select `tokens_median`.
 */
export function agentComparisonProblems(text, file = FILE) {
  const problems = []
  const words = prose(text)
  if (
    /\bfewer tool calls[^.]*\bless work\b/i.test(words) &&
    !/\bsignifican|\bMann-Whitney\b/i.test(words)
  ) {
    problems.push(
      `${file} says fewer tool calls and seconds mean less work without the significance test: effort.ts calls a difference fewer or more only when a Mann-Whitney test gives p below 0.05, not by medians alone`,
    )
  }
  const outcome = words.slice(0, words.search(/^## /m) < 0 ? undefined : words.search(/^## /m))
  const query = /reeval query "([^"]*\bFROM effort\b[^"]*)"/i.exec(text)?.[1]
  if (/\btokens\b/i.test(outcome) && query !== undefined && !/\btokens_median\b/.test(query)) {
    problems.push(
      `${file} promises tokens in its outcome but its effort query doesn't select tokens_median`,
    )
  }
  return problems
}

export function recipeProblems(docsDir) {
  return agentComparisonProblems(
    readFileSync(join(docsDir, 'recipes/agent-comparison.mdx'), 'utf8'),
  )
}
