// A schema module the view boundary test allows zod in, when it's named, and in what it loads.
import { z } from 'zod'
import { id } from './schema-helper.ts'

export const shape = z.object({ id })
