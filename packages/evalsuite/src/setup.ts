import { connectScheduler, extendExpect, holdFileUntilEvalsSettle } from './engine/runtime.ts'
import { matchers } from './matchers.ts'

extendExpect(matchers)
holdFileUntilEvalsSettle()
connectScheduler()
