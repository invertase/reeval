import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

// The official Python image: reeval bakes Node, git and the agent onto it on the first run.
const python = defineEnvironment('python', {
  sandbox: docker({ from: 'python:3.12-slim', id: 'python' }),
})

evaluate('writes and tests fizzbuzz in Python', { environment: python }, async (c) => {
  await c.send(
    'Write fizzbuzz.py with a function fizzbuzz(n) that returns the FizzBuzz string for n, and ' +
      'test_fizzbuzz.py with unittest tests for 3, 5, 15 and 7. Standard library only.',
  )

  await expect(c.exec('python3 --version')).toSucceed()
  await expect(c.exec('python3 -m unittest -q')).toSucceed()
})
