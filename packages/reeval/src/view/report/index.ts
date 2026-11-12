// `reeval/view/report`: the RunReport contract. Everything `reeval/view` has of it (types, build,
// formatters, labels, links), plus the Zod schemas, the report's and the analysis document's it
// pins, which only this subpath carries so the `reeval/view` root stays free of zod.

export { analysisDocSchema, parsedAnalysis } from '../analysis-schema.ts'
export * from './core.ts'
export {
  attemptRefSchema,
  countSchema,
  deltaSchema,
  figureSchema,
  headlinePrimarySchema,
  intervalSchema,
  looseRunReportSchema,
  rateSchema,
  readableRunReport,
  reportClaimSchema,
  runReportSchema,
  spreadSchema,
} from './schema.ts'
