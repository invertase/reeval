import { defineEnvironment } from 'reeval'

// The plan lists each cell's files: what directory() walked, after its globs and ignores.
export const whole = defineEnvironment('whole', ({ directory }) => ({
  files: directory('../fixture'),
}))

// Includes, an exclude and a re-include, in order: the last pattern that matches decides.
export const picked = defineEnvironment('picked', ({ directory }) => ({
  files: directory('../fixture', {
    glob: ['src/**', 'package.json', '!**/*.test.ts', '!src/gen/', 'src/gen/keep.ts'],
    into: 'app',
  }),
}))

export const everything = defineEnvironment('everything', ({ directory }) => ({
  files: directory('../fixture', { defaultIgnores: false }),
}))

// A later key overrides: a spread directory composes with literal files and other directories.
export const composed = whole.extendEnvironment('composed', ({ directory }) => ({
  files: { ...directory('../fixture/py', { into: 'tools' }), 'NOTES.md': 'something' },
}))
