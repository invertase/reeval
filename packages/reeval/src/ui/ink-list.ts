// The interactive status list, drawn with Ink: ↑↓ move, → or enter expands one eval, ← or esc
// folds it. While the run goes, Ctrl-C cancels it and so does q pressed twice; once it has ended,
// q quits, taking the frame down so `tty.ts` can print the whole list into the scrollback. Only
// `tty.ts` imports this module, and only on an interactive terminal, so nothing else loads React.
import { Box, render, Static, Text, useApp, useInput, useStdout } from 'ink'
import {
  createElement as h,
  type ReactElement,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { type Colors, stripAnsi } from './colors.ts'
import { nameWidth, paintDetail, paintIcon, SPINNER } from './list.ts'
import type { StatusRow } from './status.ts'
import type { ListState, ListStore } from './tty.ts'

const FRAME_MS = 80
/** How long a first q during the run waits for the second that cancels it. */
export const CONFIRM_MS = 3000

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

/** The terminal lines `lines` take at `columns`, each wrapped as the terminal wraps it. */
const tall = (lines: string[], columns: number) =>
  lines.reduce((n, l) => n + Math.max(1, Math.ceil(stripAnsi(l).length / columns)), 0)

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
  /** What Ctrl-C, or q pressed twice, does while the run goes: cancel it. */
  cancel: () => void
}

export function ListApp({ store, colors: c, cancel }: ListAppProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [selected, setSelected] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [quitting, setQuitting] = useState(false)
  const [size, setSize] = useState(() => sizeOf(stdout))
  const rows = rowsOf(state)
  const finished = state.finished

  useEffect(() => {
    const resize = () => setSize(sizeOf(stdout))
    stdout.on('resize', resize)
    return () => {
      stdout.off('resize', resize)
    }
  }, [stdout])

  useEffect(() => {
    if (finished) return
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [finished])

  useEffect(() => {
    if (!confirming || finished) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming, finished])

  // The empty frame has to be drawn before Ink unmounts, so nothing of the list is left behind.
  useEffect(() => {
    if (quitting) exit()
  }, [quitting, exit])

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
    if (finished && (input === 'q' || (key.ctrl && input === 'c'))) {
      setQuitting(true)
      return
    }
    if (key.ctrl && input === 'c') return cancel()
    if (input === 'q') {
      if (confirming) cancel()
      setConfirming(!confirming)
      return
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSelected((s) => Math.min(rows.length - 1, s + 1))
    else if (key.rightArrow || key.return) {
      const id = rows[selected]?.id ?? null
      setExpanded((e) => (key.return && e === id ? null : id))
    } else if (key.leftArrow || key.escape) setExpanded(null)
  })

  const logs = h(Static<string>, {
    key: 'logs',
    items: state.logs,
    // biome-ignore lint/correctness/noChildrenProp: Static's children is a render function, which createElement's types don't take as a child
    children: (line, i) => h(Text, { key: i }, line),
  })
  if (quitting) return h(Box, { flexDirection: 'column' }, logs)

  const { rows: rowsTall, columns } = size
  const keys = finished ? '↑↓ move · → open · ← close · q quit' : '↑↓ move · → open · q cancel'
  const head = state.phase ? [state.phase, ' '] : []
  const footer = [
    ' ',
    ...(finished
      ? [
          ...finished.errors.map((e) => c.red(`error: ${e.split('\n')[0] ?? ''}`)),
          ...finished.notes.map((n) => c.yellow(n)),
          finished.done,
          c.dim(finished.pointer),
        ]
      : [c.dim(`${state.counts.done} of ${state.counts.total} evals done`)]),
    confirming && !finished ? c.yellow('Press q again to cancel the run.') : c.dim(keys),
  ]
  // One line spare, so Ink never draws a frame as tall as the terminal (it clears the screen then).
  const height = Math.max(3, rowsTall - tall(head, columns) - tall(footer, columns) - 1)
  const lines = windowOf(frameLines(state, c, selected, expanded, frame, columns), selected, height)
  return h(
    Box,
    { flexDirection: 'column' },
    logs,
    ...head.map((line, i) => h(Text, { key: `h${i}` }, line)),
    ...lines.map((l, i) => h(Text, { key: `l${i}`, wrap: 'truncate-end' }, l.text || ' ')),
    ...footer.map((line, i) => h(Text, { key: `f${i}` }, line)),
  )
}

const sizeOf = (stdout: NodeJS.WritableStream) => {
  const { rows, columns } = stdout as { rows?: number; columns?: number }
  return { rows: rows || 24, columns: columns || 80 }
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
