import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'

export const plain = defineEnvironment('plain', {
  sandbox: fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) }),
})

/** A made-up key in Anthropic's shape, which reeval masks wherever it writes it. */
export const KEY = 'sk-ant-reeval-fixture-not-a-key-0000'
