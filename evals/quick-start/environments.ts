import { defineEnvironment, type Environment } from 'reeval'

/**
 * This checkout's reeval, packed by `node evals/skill/scripts/vendor.mjs`. It sits outside the
 * workspace, so installing it is part of the agent's setup and nothing the eval seeds counts as
 * the agent's change.
 */
const tarball = { '~/reeval.tgz': '../skill/vendor/reeval.tgz' }

/** Pinned public repositories with skills, fetched on the host before any attempt. */
const SUPABASE = {
  repo: 'https://github.com/supabase/agent-skills',
  ref: 'c9be0e931b7930f7d02126d04774d904c381e7d7',
}
const FIREBASE = {
  repo: 'https://github.com/firebase/agent-skills',
  ref: '92eed24c0976a79a66d5b8038e9eda8b441ef92d',
}

/** A starting directory: a repo with skills and no reeval, the same with reeval set up, or nothing. */
export type Target = 'supabase' | 'firebase-set-up' | 'empty'

function start(target: Target): Environment {
  return defineEnvironment(target, ({ file, git }) => {
    const files = Object.fromEntries(Object.entries(tarball).map(([to, from]) => [to, file(from)]))
    if (target === 'supabase')
      return { workspace: git(SUPABASE.repo, { ref: SUPABASE.ref, init: true }), files }
    if (target === 'firebase-set-up') {
      return {
        workspace: git(FIREBASE.repo, { ref: FIREBASE.ref, init: true }),
        files,
        // What a user who ran `reeval init` once has: its config, example eval and package.json.
        setup: [
          {
            run: 'npm init -y >/dev/null && npm i -D ~/reeval.tgz --no-audit --no-fund --loglevel=error && npx reeval init --harness cursor',
            timeout: '5m',
          },
        ],
      }
    }
    return { files }
  })
}

/**
 * Each target twice: the control has the reeval skill, which teaches the API; the variant adds
 * the quick-start skill on top, which is what it should add.
 */
export function arms(target: Target) {
  const base = start(target)
  const control = base.extendEnvironment(`${target}-reeval-skill`, ({ skill }) => ({
    skills: [skill.local('../../skills/reeval')],
  }))
  const variant = base.extendEnvironment(`${target}-quick-start`, ({ skill }) => ({
    skills: [skill.local('../../skills/reeval'), skill.local('../../skills/quick-start')],
  }))
  return { baseline: control, variants: [variant] }
}
