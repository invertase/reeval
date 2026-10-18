// Whether reeval still needs its patch to @ai-sdk/harness-claude-code (pnpm-workspace.yaml's
// patchedDependencies): the newest adapter from npm, key-free. It replays a real captured turn
// (packages/reeval/test/fixtures/claude-code-bridge/) through that version's own bridge.
//   Upstream reports the served model unpatched: it fixed the bug, so drop the patch (exit 1).
//   The patch no longer applies, or applied doesn't report the model: rebase it (exit 1).
//   Otherwise the patch is still needed and still works on the newest version (exit 0).
//   node --experimental-strip-types --no-warnings scripts/drift/claude-code-patch.mjs
// REEVAL_DRIFT_CLAUDE_CODE_VERSION names a version instead of the newest. Appends a line to
// $GITHUB_STEP_SUMMARY when it's set.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { replayBridge } from '../../packages/reeval/test/support/claude-code-bridge.ts'

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
const servedModel = async (dir) =>
  (await replayBridge({ bridge: join(dir, 'dist/bridge/index.mjs'), start, messages })).find(
    (p) => p.type === 'stream-start',
  )?.modelId

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

  if ((await servedModel(pkg)) === MODEL)
    report(
      false,
      `${latest} reports the served model unpatched: upstream fixed it. Drop ${patchFile} and its patchedDependencies entry, and bump from ${pinned}.`,
    )

  // pnpm applies a patch only at its exact lines, where git apply would move a hunk.
  const apply = spawnSync('git', ['apply', '-v', '-p1', patch], { cwd: pkg, encoding: 'utf8' })
  if (apply.status !== 0 || /\(offset -?\d+ lines?\)/.test(apply.stderr))
    report(
      false,
      `${patchFile} doesn't apply to ${latest}, which still loses the served model: rebase it with pnpm patch.\n${apply.stderr}`,
    )
  const patched = await servedModel(pkg)
  if (patched !== MODEL)
    report(false, `${patchFile} applies to ${latest} but its bridge still reports ${patched}`)

  report(
    true,
    `still needed: ${latest} loses the served model, and ${patchFile} (pinned ${pinned}) applies to it and fixes it.`,
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
