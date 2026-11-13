// The interactive status list, drawn with Ink: ↑↓ move, → or enter expands one eval (an eval
// with cases shows `CASES_OPEN` of them, failed and running first, → again all of them), ← steps
// back and esc folds it. While the run goes, Ctrl-C cancels it and so does q pressed twice; once
// it has ended, q quits, taking the frame down so `tty.ts` can print the whole list into the
// scrollback. Following another process's run (`reeval attach`), q and Ctrl-C leave the list at
// once and the run goes on; x pressed twice cancels the run, while the store says it can be
// reached. Only `tty.ts` imports this module, and only on an interactive terminal, so nothing
// else loads React.
import { Box, render, Static, Text, useApp, useInput, useStdout } from 'ink'
import {
  createElement as h,
  type ReactElement,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { redactSecrets } from '../redact.ts'
import { type Colors, stripAnsi } from './colors.ts'
import { detailSegments, nameWidth, paintIcon, type Segment, SPINNER } from './list.ts'
import { type DetailLine, type StatusRow, shownDetail } from './status.ts'
import type { ListState, ListStore } from './tty.ts'

const FRAME_MS = 80
/** How long a first q (x, following another process's run) waits for the second that cancels it. */
export const CONFIRM_MS = 3000

type Line = { text: string; row: number }

/** Case rows an open eval shows before → shows them all. */
export const CASES_OPEN = 5

/** Which case rows the compact detail keeps first: the failed, then the running, then the rest. */
const caseRank = (l: DetailLine) =>
  l.mark === 'fail' || l.mark === 'miss' || l.mark === 'error' ? 0 : l.mark === 'spin' ? 1 : 2

/**
 * The open eval's detail: compact, with `CASES_OPEN` of its case table's cases (failed and running
 * ones first, in the table's order) and how many it hides, whatever the compact detail of a
 * printed list would show; `full`, everything.
 */
export function openDetail(lines: DetailLine[], full: boolean): DetailLine[] {
  if (full || !lines.some((l) => l.cases === 'row')) return shownDetail(lines, full)
  const rows = lines.filter((l) => l.cases === 'row')
  const shown = new Set(
    rows
      .map((l, i) => [l, i] as const)
      .sort(([a, i], [b, j]) => caseRank(a) - caseRank(b) || i - j)
      .slice(0, CASES_OPEN)
      .map(([l]) => l),
  )
  const hidden = rows.length - shown.size
  const out: DetailLine[] = []
  for (const l of lines) {
    if (l.cases === 'more') continue
    if (l.cases === 'head' || shown.has(l)) out.push(l)
    else if (l.cases !== 'row' && l.only !== 'full') out.push(l)
    if (hidden && l === rows.at(-1)) {
      const text = `${hidden} ${hidden === 1 ? 'case' : 'cases'} hidden, → to show`
      out.push({ depth: l.depth, text: `${l.mark ? '  ' : ''}${text}`, tone: 'dim' })
    }
  }
  return out
}

/** Whether → on the open eval shows more than it does now. */
const hasMore = (lines: DetailLine[]) => {
  const open = openDetail(lines, false)
  const full = openDetail(lines, true)
  return open.length !== full.length || open.some((l, i) => l !== full[i])
}

/** Where `text` breaks into lines of at most `width` characters, at spaces where it can. */
function wrapRanges(text: string, width: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let start = 0
  while (text.length - start > width) {
    const space = text.lastIndexOf(' ', start + width)
    const cut = space > start + width / 3 ? space : start + width
    let end = cut
    while (end > start && text[end - 1] === ' ') end--
    out.push([start, end])
    start = cut
    while (text[start] === ' ') start++
  }
  out.push([start, text.length])
  return out
}

/** `text` in lines of at most `width` characters, broken at spaces where it can be. */
export function wrap(text: string, width: number): string[] {
  return wrapRanges(text, width).map(([a, b]) => text.slice(a, b))
}

/** Segments wrapped as their text would be, each piece in its own segment's paint. */
export function wrapSegments(segments: Segment[], width: number): string[] {
  const text = segments.map((s) => s.text).join('')
  return wrapRanges(text, width).map(([a, b]) => {
    let at = 0
    let out = ''
    for (const s of segments) {
      const from = Math.max(a, at)
      const to = Math.min(b, at + s.text.length)
      if (to > from) out += s.paint(s.text.slice(from - at, to - at))
      at += s.text.length
    }
    return out
  })
}

/** The list's lines, each tagged with the index of the row it belongs to (-1 for a file heading). */
export function frameLines(
  state: ListState,
  c: Colors,
  selected: number,
  expanded: string | null,
  frame: number,
  columns = 80,
  /** The open eval's full detail: file excerpts, snapshots, remarks' whole sentences. */
  full = false,
): Line[] {
  const out: Line[] = []
  let i = 0
  for (const [n, file] of state.files.entries()) {
    if (n) out.push({ text: '', row: -1 })
    out.push({ text: c.bold(file.path), row: -1 })
    const width = nameWidth(file.rows)
    for (const row of file.rows) {
      const here = i === selected
      const spins = row.icon === 'running' || row.icon === 'failing'
      const glyph = spins ? SPINNER[frame % SPINNER.length] : undefined
      const name =
        row.name.length > width ? `${row.name.slice(0, width - 1)}…` : row.name.padEnd(width)
      const pointer = here ? c.blue('❯') : ' '
      const label = here ? c.bold(name) : name
      out.push({
        text: `${pointer} ${paintIcon(c, row.icon, glyph)} ${label}  ${c.dim(row.summary)}`,
        row: i,
      })
      if (expanded === row.id) {
        const spinner = SPINNER[frame % SPINNER.length]
        for (const line of openDetail(row.detail, full)) {
          const indent = 6 + line.depth * 2
          const parts = wrapSegments(
            detailSegments(c, line, spinner),
            Math.max(20, columns - indent),
          )
          // A wrapped line's continuation starts under its text, past the mark.
          const under = ' '.repeat(indent + (line.mark ? 2 : 0))
          for (const [k, part] of parts.entries()) {
            out.push({ text: k === 0 ? `${' '.repeat(indent)}${part}` : `${under}${part}`, row: i })
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
  /**
   * Cancels the run: Ctrl-C or q pressed twice while it goes, or x pressed twice under `detach`,
   * where without it there's no key that cancels. There it returns false when the run could not
   * be reached after all.
   */
  cancel?: () => boolean | undefined
  /**
   * Set when the run is another process's: q and Ctrl-C call it while the run goes and take the
   * list down, leaving the run alone.
   */
  detach?: () => void
  /** Under `detach`, how to cancel a run no key here can reach, shown in place of x. */
  cancelHint?: string
}

export function ListApp({
  store,
  colors: c,
  cancel,
  detach,
  cancelHint,
}: ListAppProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [selected, setSelected] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [frame, setFrame] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [quitting, setQuitting] = useState(false)
  const [canceled, setCanceled] = useState(false)
  const [refused, setRefused] = useState(false)
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

  useEffect(() => {
    if (state.quit) setQuitting(true)
  }, [state.quit])

  // Once the run ends, the first failure (else the first eval with remarks) is selected and open.
  useEffect(() => {
    if (!finished) return
    const all = rowsOf(store.get())
    const failed = all.findIndex((r) => r.icon === 'fail')
    const first = failed >= 0 ? failed : all.findIndex((r) => r.remarks > 0)
    if (first < 0) return
    setSelected(first)
    setExpanded(all[first]?.id ?? null)
    setFull(false)
  }, [finished, store])

  const cancelable = !!detach && !!cancel && state.cancelable === true && !canceled

  useInput((input, key) => {
    setRefused(false)
    if (finished && (input === 'q' || (key.ctrl && input === 'c'))) {
      setQuitting(true)
      return
    }
    if (detach && !finished) {
      if (input === 'q' || (key.ctrl && input === 'c')) {
        detach()
        setQuitting(true)
        return
      }
      if (input === 'x' && cancelable) {
        if (confirming) {
          if (cancel?.() === false) setRefused(true)
          else setCanceled(true)
        }
        setConfirming(!confirming)
        return
      }
    } else if (!finished) {
      if (key.ctrl && input === 'c') return cancel?.()
      if (input === 'q') {
        if (confirming) cancel?.()
        setConfirming(!confirming)
        return
      }
    }
    const id = rows[selected]?.id ?? null
    // → opens an eval, and on an open one shows its full detail; ← steps back the same way.
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSelected((s) => Math.min(rows.length - 1, s + 1))
    else if (key.rightArrow) {
      if (expanded === id) setFull(true)
      else {
        setExpanded(id)
        setFull(false)
      }
    } else if (key.return) {
      setExpanded(expanded === id ? null : id)
      setFull(false)
    } else if (key.leftArrow || key.escape) {
      if (full && !key.escape) setFull(false)
      else {
        setExpanded(null)
        setFull(false)
      }
    }
  })

  const logs = h(Static<string>, {
    key: 'logs',
    items: state.logs,
    // biome-ignore lint/correctness/noChildrenProp: Static's children is a render function, which createElement's types don't take as a child
    children: (line, i) => h(Text, { key: i }, line),
  })
  if (quitting) return h(Box, { flexDirection: 'column' }, logs)

  const { rows: rowsTall, columns } = size
  const here = rows[selected]
  const open = here && here.id === expanded ? here : undefined
  const more = open && !full && hasMore(open.detail)
  const step = more ? '→ more' : '→ open'
  const keys = finished
    ? `↑↓ move · ${step} · ← close · q quit`
    : detach
      ? `↑↓ move · ${step} · q detach${cancelable ? ' · x cancel the run' : cancelHint ? ` · ${cancelHint}` : ''}`
      : `↑↓ move · ${step} · q cancel`
  const confirm = detach ? 'Press x again to cancel the run.' : 'Press q again to cancel the run.'
  // The phase spins while reeval waits on the run, and settles once it ends.
  const glyph = finished ? c.teal('◆') : c.teal(SPINNER[frame % SPINNER.length] ?? '◆')
  const head = state.phase ? [`  ${glyph}  ${state.phase}`, ' '] : []
  const footer = [
    ' ',
    ...(finished
      ? [
          ...finished.errors.map((e) => c.red(`error: ${e.split('\n')[0] ?? ''}`)),
          ...finished.notes.map((n) => c.yellow(n)),
          finished.done,
          c.dim(finished.pointer),
        ]
      : [doneLine(c, state.counts)]),
    refused && !finished
      ? c.yellow("The run can't be canceled from here now.")
      : confirming && !finished && (cancelable || !detach)
        ? c.yellow(confirm)
        : c.dim(keys),
  ]
  // One line spare, so Ink never draws a frame as tall as the terminal (it clears the screen then).
  const height = Math.max(3, rowsTall - tall(head, columns) - tall(footer, columns) - 1)
  const lines = windowOf(
    frameLines(state, c, selected, expanded, frame, columns, full),
    selected,
    height,
  )
  return h(
    Box,
    { flexDirection: 'column' },
    logs,
    ...head.map((line, i) => h(Text, { key: `h${i}` }, line)),
    ...lines.map((l, i) => h(Text, { key: `l${i}`, wrap: 'truncate-end' }, l.text || ' ')),
    ...footer.map((line, i) => h(Text, { key: `f${i}` }, line)),
  )
}

/**
 * `9 of 10 evals done · 1 failed · 1 failing`: the evals that ended failed, and those still going
 * with a run that already failed, which a red spinner marks.
 */
export function doneLine(c: Colors, counts: ListState['counts']): string {
  const { done, total, failed = 0, failing = 0 } = counts
  return [
    c.dim(`${done} of ${total} evals done`),
    ...(failed ? [c.red(`${failed} failed`)] : []),
    ...(failing ? [c.red(`${failing} failing`)] : []),
  ].join(c.dim(' · '))
}

const sizeOf = (stdout: NodeJS.WritableStream) => {
  const { rows, columns } = stdout as { rows?: number; columns?: number }
  return { rows: rows || 24, columns: columns || 80 }
}

/**
 * `stdout` with every write masked: Ink writes to the terminal itself, past the renderer's masked
 * output, and this is the one place all of the list's text goes through.
 */
function masking(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(stdout, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]) =>
          (target.write as (...a: unknown[]) => boolean)(
            typeof chunk === 'string' ? redactSecrets(chunk) : chunk,
            ...rest,
          )
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
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
  const props: ListAppProps = {
    store: o.store,
    colors: o.colors,
    ...(o.cancel ? { cancel: o.cancel } : {}),
    ...(o.detach ? { detach: o.detach } : {}),
    ...(o.cancelHint ? { cancelHint: o.cancelHint } : {}),
  }
  // Only an interactive terminal mounts the list, so Ink draws it live even where it detects CI.
  const app = render(h(ListApp, props), {
    interactive: true,
    stdout: masking(o.stdout),
    stdin: o.stdin,
    exitOnCtrlC: false,
    patchConsole: true,
  })
  return { waitUntilExit: () => app.waitUntilExit(), unmount: () => app.unmount() }
}
