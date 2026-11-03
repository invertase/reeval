import { defineEnvironment } from 'reeval'
import { tart } from 'reeval/sandbox'

// The fake tart keeps each VM beside the name of the image it was cloned from.
export const mac = defineEnvironment('mac', {
  sandbox: tart({ image: 'ghcr.io/cirruslabs/macos-sequoia-base:15.6' }),
  egress: 'allow-all',
})
