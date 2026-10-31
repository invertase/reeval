// Fails `pnpm docs:check` on a Claude model id Anthropic has retired on the Claude API, in any
// tracked file: a workflow, test row, example or default naming one sends a request that only
// answers 404 not_found_error. The list follows Anthropic's model deprecations page
// (https://docs.anthropic.com/en/docs/about-claude/model-deprecations); add an id once it retires.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Retired ids, their aliases, OpenRouter's dotted forms, Bedrock's (`anthropic.claude-v2:1`,
 * `us.anthropic.…`) and the `claude-4-sonnet` order: Claude 1, 2 and Instant, every Claude 3,
 * Sonnet 4 and Opus 4 (`-20250514`, `-4-0`, `-4`) and Opus 4.1.
 */
const RETIRED =
  /(?<![\w.-])(?:(?:[a-z]{2,6}(?:-gov)?\.)?anthropic[/.])?claude-(?:(?:sonnet|opus)-4(?:[-.]0|-20250514)?|opus-4[-.]1(?:-20250805)?|4(?:[-.]1)?-(?:sonnet|opus)|3(?:[-.]\d)?-(?:sonnet|haiku|opus)[\w.-]*|(?:sonnet|haiku|opus)-3(?:[-.]\d)?[\w.-]*|[12](?:\.\d)?|v[12](?::\d+)?|instant[\w.-]*)(?![\w.]|-\d)/g

/**
 * Files that quote what was, not what reeval calls: release-please writes CHANGELOG.md from PR
 * titles, and the recorded runs and captured streams replay without a request.
 */
const SKIPPED = [
  'CHANGELOG.md',
  'packages/reeval/test/fixtures/records/',
  'packages/reeval/test/replay/',
]

/**
 * Ids a file may name, because they describe a model rather than call it. Claude Code drops
 * `effort` on these (its `supportsEffort`), which still matters where a partner platform such as
 * Vertex AI keeps serving them after the Claude API retired them.
 */
const ALLOWED = {
  'packages/reeval/src/contract/harness.ts': [
    'claude-opus-4-0',
    'claude-opus-4-1',
    'claude-sonnet-4-0',
  ],
}

/** One problem per retired id per line of the tracked text files under `root`, this one aside. */
export function retiredModelProblems(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && file !== 'scripts/retired-models.mjs')
    .filter(
      (file) =>
        !SKIPPED.some((skip) => file === skip || (skip.endsWith('/') && file.startsWith(skip))),
    )
  const problems = []
  for (const file of files) {
    const allowed = ALLOWED[file]
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    text.split('\n').forEach((line, i) => {
      for (const [id] of line.matchAll(RETIRED)) {
        if (allowed?.includes(id)) continue
        problems.push(
          `${file}:${i + 1} names ${id}, which Anthropic has retired on the Claude API (requests answer 404 not_found_error): use a current model such as claude-haiku-5-5 or claude-sonnet-5-5`,
        )
      }
    })
  }
  return problems
}
