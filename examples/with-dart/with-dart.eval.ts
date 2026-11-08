import { defineEnvironment, evaluate, expect } from 'reeval'
import { boat } from 'reeval/sandbox/boat'
import { daytona } from 'reeval/sandbox/daytona'

// The official Dart image on a cloud VM: reeval builds it with Node, git and the agent into a
// saved snapshot on the first run, and later runs start from that snapshot.
const onBoat = defineEnvironment('dart-boat', {
  sandbox: boat({ from: 'dart:3.5' }),
  traits: { provider: 'boat' },
})
// Daytona runs the same recipe as the sandbox itself, which keeps its own network.
const onDaytona = defineEnvironment('dart-daytona', {
  sandbox: daytona({ from: 'dart:3.5' }),
  egress: 'allow-all',
  traits: { provider: 'daytona' },
})

evaluate('writes and tests fizzbuzz in Dart', { environments: [onBoat, onDaytona] }, async (c) => {
  await c.send(
    'Write fizzbuzz.dart with a function fizzbuzz(int n) that returns the FizzBuzz string for ' +
      'n, and fizzbuzz_test.dart, a script that checks 3, 5, 15 and 7 and exits 1 on a ' +
      'mismatch. Core libraries only, no pubspec.',
  )

  await expect(c.exec('dart --version')).toSucceed()
  await expect(c.exec('dart run fizzbuzz_test.dart')).toSucceed()
})
