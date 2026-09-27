import { extendExpect, useEngine } from './engine/runtime.ts'
import {
  connectScheduler,
  holdFileUntilEvalsSettle,
  vitestEngine,
} from './engine/vitest-runtime.ts'
import { matchers } from './matchers.ts'

useEngine(vitestEngine)
extendExpect(matchers)
holdFileUntilEvalsSettle()
connectScheduler()
