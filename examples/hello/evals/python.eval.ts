import { evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

// A non-Node toolchain: reeval bakes Node (for the harness bridge) and the Cursor CLI onto the
// official Python image the first time this runs, then reuses it.
evaluate(
  'writes and tests fizzbuzz in python',
  { sandbox: docker({ from: 'python:3.12-slim', id: 'python' }) },
  async (c) => {
    await c.send(
      'Write fizzbuzz.py with a function fizzbuzz(n) returning the usual FizzBuzz string for n, ' +
        'and test_fizzbuzz.py with unittest tests for 3, 5, 15 and 7. Standard library only.',
    )
    await expect(c.exec('python3 --version')).toSucceed()
    await expect(c.exec('python3 -m unittest -q')).toSucceed()
  },
)
