import { defineEnvironment } from 'reeval'

// A dry run never fetches, so these repositories don't have to exist.
export const pinned = defineEnvironment('pinned', ({ git }) => ({
  workspace: git('https://github.com/acme/app', { ref: 'v2.3.0', path: 'examples/basic' }),
}))

export const moving = defineEnvironment('moving', ({ git }) => ({
  workspace: git('github:acme/template'),
}))

export const next = pinned.extend('next', ({ git }) => ({
  workspace: git('https://github.com/acme/app/tree/v3.0.0/examples/basic'),
}))
