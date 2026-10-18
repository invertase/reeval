import type { SQLInputValue, StatementSync } from 'node:sqlite'

/** A statement's rows as `Row`, the columns its SQL selects: SQLite checks none of them. */
export const rowsOf = <Row extends object>(
  statement: StatementSync,
  ...params: SQLInputValue[]
): Row[] => statement.all(...params) as Row[]
