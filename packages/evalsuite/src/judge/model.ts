import type { Verdict } from '../types.ts'
import type { JudgeInput } from './index.ts'

export async function judgeWithModel(
  _model: string,
  _input: JudgeInput,
  _signal: AbortSignal,
): Promise<Verdict> {
  throw new Error('The model judge is not implemented yet')
}
