// Whether reeval still needs its patch to @ai-sdk/harness-claude-code (pnpm-workspace.yaml's
// patchedDependencies): the newest adapter from npm, key-free. It replays a real captured turn
// (packages/reeval/test/fixtures/claude-code-bridge/) through that version's own bridge, as
// captured and with a plugin's SessionStart hook reporting before system/init. The patch fixes three
// bugs: the bridge loses the served model, it counts the turn's thinking tokens as text, and it
// loads only the user's settings, so Claude Code never reads the workspace's CLAUDE.md, skills or
// settings.
//   Upstream gets all three right unpatched: drop the patch (exit 1).
//   The patch no longer applies, or applied doesn't fix all three: rebase it (exit 1).
//   Otherwise the patch is still needed and still works on the newest version (exit 0).
//   node --experimental-strip-types --no-warnings scripts/drift/claude-code-patch.mjs
// REEVAL_DRIFT_CLAUDE_CODE_VERSION names a version instead of the newest. Appends a line to
// $GITHUB_STEP_SUMMARY when it's set.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  replayBridge,
  replayBridgeQuery,
  withSessionStartHook,
} from '../../packages/reeval/test/support/claude-code-bridge.ts'

const NAME = '@ai-sdk/harness-claude-code'
const root = resolve(import.meta.dirname, '../..')
const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
const entry = workspace.match(/^ {2}'?@ai-sdk\/harness-claude-code@([^':\s]+)'?: (\S+)$/m)
if (!entry) {
  console.log(`${NAME} isn't patched: nothing to check`)
  process.exit(0)
}
const [, pinned, patchFile] = entry
const patch = join(root, patchFile)
const latest =
  process.env.REEVAL_DRIFT_CLAUDE_CODE_VERSION ||
  execFileSync('npm', ['view', NAME, 'version'], { encoding: 'utf8' }).trim()

const fixture = join(root, 'packages/reeval/test/fixtures/claude-code-bridge/edit-and-run')
const start = JSON.parse(readFileSync(`${fixture}.start.json`, 'utf8'))
const messages = readFileSync(`${fixture}.sdk.jsonl`, 'utf8')
const MODEL = 'claude-haiku-4-5'
/** The model the bridge in `dir` starts the stream with, or the first turn that lost it. */
const servedModel = async (dir) => {
  for (const turn of [messages, withSessionStartHook(messages)]) {
    const bridge = join(dir, 'dist/bridge/index.mjs')
    const parts = await replayBridge({ bridge, start, messages: turn })
    const model = parts.find((p) => p.type === 'stream-start')?.modelId
    if (model !== MODEL) return model
  }
  return MODEL
}
/** The thinking tokens the captured turn's result reports. */
const THINKING = 204
/** The reasoning tokens the bridge in `dir` gives the captured turn, or undefined. */
const reasoningTokens = async (dir) => {
  const bridge = join(dir, 'dist/bridge/index.mjs')
  const parts = await replayBridge({ bridge, start, messages })
  return parts.at(-1)?.totalUsage?.outputTokens?.reasoning
}
/** The settings sources the bridge in `dir` gives the SDK: `null` loads every one. */
const settingSources = async (dir) => {
  const bridge = join(dir, 'dist/bridge/index.mjs')
  return (await replayBridgeQuery({ bridge, start, messages })).settingSources
}
/** What the bridge in `dir` still gets wrong, or none. */
const bugs = async (dir) => {
  const model = await servedModel(dir)
  const reasoning = await reasoningTokens(dir)
  const sources = await settingSources(dir)
  return [
    ...(sources === null || sources.includes('project')
      ? []
      : [`loads no project settings (settingSources ${JSON.stringify(sources)})`]),
    ...(model === MODEL ? [] : [`loses the served model (reports ${model})`]),
    ...(reasoning === THINKING
      ? []
      : [`drops the turn's ${THINKING} thinking tokens (reports ${reasoning})`]),
  ]
}

const report = (ok, line) => {
  console.log(line)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**${NAME} patch:** ${line}\n`)
  if (!ok) {
    console.log(`::error::${line}`)
    process.exit(1)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'reeval-claude-code-drift-'))
try {
  const tarball = execFileSync('npm', ['pack', `${NAME}@${latest}`, '--silent'], {
    cwd: tmp,
    encoding: 'utf8',
  }).trim()
  execFileSync('tar', ['-xzf', tarball], { cwd: tmp })
  const pkg = join(tmp, 'package')

  const unpatched = await bugs(pkg)
  if (!unpatched.length)
    report(
      false,
      `${latest} reports the served model and the thinking tokens and loads the project's settings unpatched: upstream fixed all three. Drop ${patchFile} and its patchedDependencies entry, and bump from ${pinned}.`,
    )

  // pnpm applies a patch only at its exact lines, where git apply would move a hunk.
  const apply = spawnSync('git', ['apply', '-v', '-p1', patch], { cwd: pkg, encoding: 'utf8' })
  if (apply.status !== 0 || /\(offset -?\d+ lines?\)/.test(apply.stderr))
    report(
      false,
      `${patchFile} doesn't apply to ${latest}, which still ${unpatched.join(' and ')}: rebase it with pnpm patch.\n${apply.stderr}`,
    )
  const patched = await bugs(pkg)
  if (patched.length)
    report(false, `${patchFile} applies to ${latest} but its bridge still ${patched.join(' and ')}`)

  report(
    true,
    `still needed: ${latest} ${unpatched.join(' and ')}, and ${patchFile} (pinned ${pinned}) applies to it and fixes it.`,
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
