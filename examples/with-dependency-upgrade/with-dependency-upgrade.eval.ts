import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project, which imports strfmt 1.4.0 through package.json's "imports".
// Both versions are vendored in vendor/, so the upgrade needs no registry.
const receipts = defineEnvironment('strfmt-1', ({ directory }) => ({
  files: directory('./project'),
}))

evaluate('upgrades strfmt across its breaking change', { environment: receipts }, async (c) => {
  await c.send(
    'Upgrade strfmt from 1.4.0 to 2.0.0, which is vendored in vendor/strfmt-2.0.0 (see its ' +
      'CHANGELOG.md). Keep npm test green.',
  )

  await expect(c).toHaveFile('package.json', /"#strfmt": "\.\/vendor\/strfmt-2\.0\.0\//)
  await expect(c.exec('npm test')).toSucceed()
  expect(c, 'tests and vendor/ unchanged').not.toHaveChanged(['test/**', 'vendor/**'])
})
