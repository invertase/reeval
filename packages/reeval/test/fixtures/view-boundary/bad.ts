// Each import or global the view boundary test must refuse, once.
import { readFileSync } from 'node:fs'
import type { ZodType as OnlyType, ZodError as Types } from 'zod'
import { z } from 'zod'
import { helper } from './helper.ts'

// process.env in a comment is fine
const url = 'https://example.com/process.env'
export const read = () =>
  [readFileSync, z, helper, url, process.env.HOME] as Array<Types | OnlyType | unknown>
