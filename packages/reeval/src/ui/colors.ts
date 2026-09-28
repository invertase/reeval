export type Paint = (text: string) => string

export type Colors = {
  enabled: boolean
  green: Paint
  red: Paint
  yellow: Paint
  dim: Paint
  bold: Paint
  /** A stable colour per attempt tag, cycling Turborepo's palette in order of first use. */
  tag(key: string): Paint
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

// Turborepo's task prefix palette: cyan, magenta, green, yellow, blue.
const PALETTE = [36, 35, 32, 33, 34]

export function colors(enabled: boolean): Colors {
  const paint =
    (open: number, close = 39): Paint =>
    (text) =>
      enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text
  const tags = new Map<string, Paint>()
  return {
    enabled,
    green: paint(32),
    red: paint(31),
    yellow: paint(33),
    dim: paint(2, 22),
    bold: paint(1, 22),
    tag(key) {
      let p = tags.get(key)
      if (!p) {
        p = paint(PALETTE[tags.size % PALETTE.length] ?? 36)
        tags.set(key, p)
      }
      return p
    },
  }
}
