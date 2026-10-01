import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const parentBox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker({ from: 'node:22-bookworm', id: 'parent' })
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url), id: 'parent' })

const childBox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker({ from: 'node:24-bookworm', id: 'child' })
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url), id: 'child' })

const parent = defineEnvironment('parent', { sandbox: parentBox })

/** A child's sandbox replaces the parent's entirely; install is not merged. */
export const child = parent.extend('child', { sandbox: childBox })
