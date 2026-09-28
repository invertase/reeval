import { defineEnvironment } from 'reeval'

export const slow = defineEnvironment('slow', {
  setup: [{ run: 'sleep 30 && touch slept', timeout: '1s' }],
})

export const quick = defineEnvironment('quick', {
  setup: [{ run: 'touch slept', timeout: '30s' }],
})
