import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

// reeval's own evals, under evals/: real agents working on reeval and with it.
export default defineConfig({
  harness: cursor({ model: 'composer-2.5' }),
})
