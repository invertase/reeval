export type Paint = (text: string) => string

/** Bits per color the terminal shows: 16 colors (4), 256 (8) or truecolor (24). */
export type ColorDepth = 4 | 8 | 24

export type Colors = {
  enabled: boolean
  depth: ColorDepth
  green: Paint
  red: Paint
  yellow: Paint
  /**
   * Mid-tone accents that read on a light and a dark background alike, where the terminal has
   * 256 colors or more; on 16 colors, plain yellow, cyan and blue, which a light theme may wash out.
   */
  orange: Paint
  teal: Paint
  blue: Paint
  dim: Paint
  bold: Paint
  /** A stable color per attempt tag, cycling Turborepo's palette in order of first use. */
  tag(key: string): Paint
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

// Turborepo's task prefix palette: cyan, magenta, green, yellow, blue.
const PALETTE = [36, 35, 32, 33, 34]

/** An accent's SGR code at each depth: truecolor RGB, the xterm 256-color index, the 16-color code. */
const accent = (depth: ColorDepth, rgb: [number, number, number], index: number, basic: number) =>
  depth === 24 ? `38;2;${rgb.join(';')}` : depth === 8 ? `38;5;${index}` : String(basic)

export function colors(enabled: boolean, depth: ColorDepth = 4): Colors {
  const paint =
    (open: number | string, close = 39): Paint =>
    (text) =>
      enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text
  const tags = new Map<string, Paint>()
  return {
    enabled,
    depth,
    green: paint(32),
    red: paint(31),
    yellow: paint(33),
    orange: paint(accent(depth, [215, 95, 0], 166, 33)),
    teal: paint(accent(depth, [0, 135, 175], 31, 36)),
    blue: paint(accent(depth, [0, 135, 255], 33, 34)),
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
