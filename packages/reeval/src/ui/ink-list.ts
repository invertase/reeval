// The interactive status list, drawn with Ink: ↑↓ move, → or enter expands one eval, ← or esc
// folds it, q cancels a run in progress (as Ctrl-C does) and quits once it has ended. Only
// `tty.ts` imports this module, and only on an interactive terminal, so nothing else loads React.
import { Box, render, Static, Text, useApp, useInput, useStdout } from 'ink'
import {
  createElement as h,
  type ReactElement,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Colors } from './colors.ts'
import { nameWidth, paintDetail, paintIcon, SPINNER } from './list.ts'
import type { StatusRow } from './status.ts'
import type { ListState, ListStore } from './tty.ts'

const FRAME_MS = 80
/** Lines kept for the header and footer when the list is taller than the terminal. */
const CHROME = 6

type Line = { text: string; row: number }

/** `text` in lines of at most `width` characters, broken at spaces where it can be. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width)
    const cut = space > width / 3 ? space : width
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  out.push(rest)
  return out
}

/** The list's lines, each tagged with the index of the row it belongs to (-1 for a file heading). */
export function frameLines(
  state: ListState,
  c: Colors,
  selected: number,
  expanded: string | null,
  frame: number,
  columns = 80,
): Line[] {
  const out: Line[] = []
  let i = 0
  for (const [n, file] of state.files.entries()) {
    if (n) out.push({ text: '', row: -1 })
    out.push({ text: c.bold(file.path), row: -1 })
    const width = nameWidth(file.rows)
    for (const row of file.rows) {
      const here = i === selected
      const glyph = row.icon === 'running' ? SPINNER[frame % SPINNER.length] : undefined
      const name =
        row.name.length > width ? `${row.name.slice(0, width - 1)}…` : row.name.padEnd(width)
      const pointer = here ? c.blue('❯') : ' '
      const label = here ? c.bold(name) : name
      out.push({
        text: `${pointer} ${paintIcon(c, row.icon, glyph)} ${label}  ${c.dim(row.summary)}`,
        row: i,
      })
      if (expanded === row.id) {
        for (const line of row.detail) {
          const indent = 6 + line.depth * 2
          for (const part of wrap(line.text, Math.max(20, columns - indent))) {
            out.push({ text: `      ${paintDetail(c, { ...line, text: part })}`, row: i })
          }
        }
      }
      i++
    }
  }
  return out
}

/** The rows in list order. */
const rowsOf = (state: ListState): StatusRow[] => state.files.flatMap((f) => f.rows)

/** The lines that fit `height`, scrolled so the selected row is on screen. */
function windowOf(lines: Line[], selected: number, height: number): Line[] {
  if (lines.length <= height) return lines
  const first = lines.findIndex((l) => l.row === selected)
  const last = lines.findLastIndex((l) => l.row === selected)
  const start = Math.max(0, Math.min(first, last - height + 1, lines.length - height))
  return lines.slice(start, start + height)
}

export type ListAppProps = {
  store: ListStore
  colors: Colors
  /** What q and Ctrl-C do while the run goes: cancel it. */
  cancel: () => void
}

export function ListApp({ store, colors: c, cancel }: ListAppProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [selected, setSelected] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const rows = rowsOf(state)
  const finished = state.finished

  useEffect(() => {
    if (finished) return
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [finished])

  // Once the run ends, the first failure (else the first eval with remarks) is selected and open.
  useEffect(() => {
    if (!finished) return
    const all = rowsOf(store.get())
    const failed = all.findIndex((r) => r.icon === 'fail')
    const first = failed >= 0 ? failed : all.findIndex((r) => r.remarks > 0)
    if (first < 0) return
    setSelected(first)
    setExpanded(all[first]?.id ?? null)
  }, [finished, store])

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      if (finished) exit()
      else cancel()
      return
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSelected((s) => Math.min(rows.length - 1, s + 1))
    else if (key.rightArrow || key.return) {
      const id = rows[selected]?.id ?? null
      setExpanded((e) => (key.return && e === id ? null : id))
    } else if (key.leftArrow || key.escape) setExpanded(null)
  })

  const { rows: rowsTall = 24, columns = 80 } = stdout as { rows?: number; columns?: number }
  const height = Math.max(3, rowsTall - CHROME)
  const lines = windowOf(frameLines(state, c, selected, expanded, frame, columns), selected, height)
  const keys = finished ? '↑↓ move · → open · ← close · q quit' : '↑↓ move · → open · q cancel'
  const footer = finished
    ? [
        ...finished.errors.map((e) => c.red(`error: ${e.split('\n')[0] ?? ''}`)),
        ...finished.notes.map((n) => c.yellow(n)),
        finished.done,
        c.dim(finished.pointer),
      ]
    : [c.dim(`${state.counts.done} of ${state.counts.total} evals done`)]
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static<string>, {
      items: state.logs,
      // biome-ignore lint/correctness/noChildrenProp: Static's children is a render function, which createElement's types don't take as a child
      children: (line, i) => h(Text, { key: i }, line),
    }),
    ...lines.map((l, i) => h(Text, { key: `l${i}`, wrap: 'truncate-end' }, l.text || ' ')),
    h(Text, { key: 'gap' }, ' '),
    ...footer.map((line, i) => h(Text, { key: `f${i}` }, line)),
    h(Text, { key: 'keys' }, c.dim(keys)),
  )
}

export type MountOptions = ListAppProps & {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
}

/** Draws the list on the terminal; resolves once the user quits it. */
export function mountList(o: MountOptions): {
  waitUntilExit: () => Promise<unknown>
  unmount: () => void
} {
  const app = render(h(ListApp, { store: o.store, colors: o.colors, cancel: o.cancel }), {
    stdout: o.stdout,
    stdin: o.stdin,
    exitOnCtrlC: false,
    patchConsole: true,
  })
  return { waitUntilExit: () => app.waitUntilExit(), unmount: () => app.unmount() }
}
