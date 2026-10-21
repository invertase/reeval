import { defineEnvironment, type Environment } from 'reeval'

/**
 * One task's starting project: a reeval project on the fake trio, with this checkout's reeval
 * (packed into vendor/ by scripts/vendor.mjs) and TypeScript installed by the setup step. `after`
 * runs once the install is done.
 */
export function project(name: string, fixture: string, after: string[] = []): Environment {
  return defineEnvironment(name, ({ directory, file }) => ({
    files: {
      ...directory('../../../fixtures/skill-common'),
      ...directory(`../../../fixtures/skill-${fixture}`),
      'vendor/reeval.tgz': file('./vendor/reeval.tgz'),
    },
    setup: [{ run: 'npm install --no-audit --no-fund', timeout: '5m' }, ...after],
  }))
}

/** The workspace path in reeval's Docker sandbox; `reeval mcp` has no other way to find it. */
const WORKSPACE = '/reeval/workspace'

/**
 * The four ways an agent can learn reeval, each alone, on top of the task's project. The
 * control is the skill before the split; the variants are the split skill, the docs site's
 * pages in `reeval-docs/`, and `reeval mcp` (run history only) as an MCP server.
 */
export function channels(base: Environment) {
  const skillCurrent = base.extendEnvironment('skill-current', ({ skill }) => ({
    skills: [skill.local('./vendor/skill-current/reeval')],
  }))
  const skillSplit = base.extendEnvironment('skill-split', ({ skill }) => ({
    skills: [skill.local('../../../skills/reeval')],
  }))
  const docs = base.extendEnvironment('docs', ({ directory }) => ({
    files: directory('./vendor/docs', { into: 'reeval-docs' }),
  }))
  const mcp = base.extendEnvironment('mcp', ({ mcp }) => ({
    mcp: {
      reeval: mcp.stdio('node', [
        `${WORKSPACE}/node_modules/reeval/dist/cli.js`,
        'mcp',
        '--config',
        `${WORKSPACE}/reeval.config.ts`,
      ]),
    },
  }))
  return { baseline: skillCurrent, variants: [skillSplit, docs, mcp] }
}

/** Shared by every task: the starter workspace the agent edits (its own fake-harness config). */
export const PREAMBLE =
  'This workspace is a small reeval project (npm package `reeval` is installed; use `npx reeval`). ' +
  'Its `reeval.config.ts` uses reeval’s fake harness so `npx reeval run` and `--dry-run` work inside ' +
  'the project without API keys. '
