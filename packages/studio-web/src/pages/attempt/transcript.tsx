import { useWindowVirtualizer } from '@tanstack/react-virtual'
import {
  Brain,
  ChevronRight,
  CircleAlert,
  FileMinus,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  MessageSquare,
  RotateCcw,
  Search,
  TerminalSquare,
  UserRound,
  Wrench,
} from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  formatDuration,
  parseTranscript,
  type TranscriptItem,
  type TranscriptLine,
  transcriptItems,
} from 'reeval/view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type EventLine = Exclude<TranscriptLine, { type: 'prompt' | 'turn-end' }>

/** `write` created the file or replaced it whole: the harness doesn't say which. */
const FILE_EDIT: Record<
  Extract<EventLine, { type: 'file-edit' }>['kind'],
  { Icon: typeof FilePen; verb: string }
> = {
  create: { Icon: FilePlus, verb: 'Created' },
  modify: { Icon: FilePen, verb: 'Edited' },
  write: { Icon: FileText, verb: 'Wrote' },
  delete: { Icon: FileMinus, verb: 'Deleted' },
}

const offset = (ms: number) => (ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`)

const pretty = (value: unknown) =>
  typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)

/** One-line summary of a tool call's input: the command, path or first string field. */
function inputSummary(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  for (const key of ['command', 'cmd', 'path', 'file', 'filePath', 'pattern', 'query', 'url']) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string') return value
  }
  const first = Object.values(input).find((v) => typeof v === 'string')
  return typeof first === 'string' ? first : ''
}

function Foldable({
  open,
  onToggle,
  icon: Icon,
  tone,
  title,
  meta,
  children,
}: {
  open: boolean
  onToggle: () => void
  icon: typeof Wrench
  tone?: string
  title: React.ReactNode
  meta?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <Icon className={cn('size-4 shrink-0 text-muted-foreground', tone)} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta ? <span className="shrink-0 text-xs text-muted-foreground">{meta}</span> : null}
      </button>
      {open ? <div className="border-t bg-muted/30">{children}</div> : null}
    </div>
  )
}

function Block({ label, text }: { label: string; text: string }) {
  if (!text) return null
  return (
    <div className="px-3 py-2">
      <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <pre className="max-h-96 overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  )
}

function EventRow({ e, open, toggle }: { e: EventLine; open: boolean; toggle: () => void }) {
  const dur = 'durationMs' in e && e.durationMs ? formatDuration(e.durationMs) : null
  switch (e.type) {
    case 'text':
      return (
        <div className="flex gap-3">
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
            <MessageSquare className="size-3.5" />
          </div>
          <p className="min-w-0 flex-1 pt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
            {e.text}
          </p>
        </div>
      )
    case 'reasoning':
      return (
        <Foldable
          open={open}
          onToggle={toggle}
          icon={Brain}
          tone="text-drift"
          title={
            <span className="text-muted-foreground italic">
              {open ? 'Reasoning' : e.text.split('\n')[0]}
            </span>
          }
          meta={dur ? `thought for ${dur}` : 'reasoning'}
        >
          <p className="px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
            {e.text}
          </p>
        </Foldable>
      )
    case 'tool':
      return (
        <Foldable
          open={open}
          onToggle={toggle}
          icon={
            e.tool.toLowerCase().includes('shell') || e.tool === 'bash' ? TerminalSquare : Wrench
          }
          tone={e.ok === false ? 'text-fail' : undefined}
          title={
            <>
              <span className="font-medium">{e.tool}</span>
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {inputSummary(e.input)}
              </span>
            </>
          }
          meta={
            <span className="flex items-center gap-2">
              {e.ok === false ? <span className="text-fail">failed</span> : null}
              {e.ok === null ? <span className="text-muted-foreground">unfinished</span> : null}
              {dur}
            </span>
          }
        >
          <Block label="Input" text={pretty(e.input)} />
          <Block label="Output" text={pretty(e.output)} />
        </Foldable>
      )
    case 'file-edit': {
      // A newer reeval's kind reads as an edit.
      const { Icon, verb } = FILE_EDIT[e.kind] ?? FILE_EDIT.modify
      return (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
          <Icon className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">{verb}</span>
          <span className="min-w-0 truncate font-mono text-xs">{e.path}</span>
          <span className="ml-auto flex shrink-0 gap-2 font-mono text-xs">
            {e.added !== null ? <span className="text-pass">+{e.added}</span> : null}
            {e.removed !== null ? <span className="text-fail">−{e.removed}</span> : null}
            {dur ? <span className="text-muted-foreground">{dur}</span> : null}
          </span>
        </div>
      )
    }
    case 'web-search':
      return (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
          <Search className={cn('size-4 text-muted-foreground', e.ok === false && 'text-fail')} />
          <span className="text-muted-foreground">Searched</span>
          <span className="min-w-0 truncate">“{e.query}”</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {e.references !== null ? `${e.references} sources · ` : ''}
            {dur}
          </span>
        </div>
      )
    case 'web-fetch':
      return (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
          <Globe className={cn('size-4 text-muted-foreground', e.ok === false && 'text-fail')} />
          <span className="text-muted-foreground">Fetched</span>
          <span className="min-w-0 truncate font-mono text-xs">{e.url}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{dur}</span>
        </div>
      )
    case 'retry':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <RotateCcw className="mt-0.5 size-4 shrink-0" />
          <span className="font-mono text-xs break-words whitespace-pre-wrap">{e.message}</span>
        </div>
      )
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-fail/30 bg-fail/5 px-3 py-2 text-sm text-fail">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="font-mono text-xs break-words whitespace-pre-wrap">{e.message}</span>
        </div>
      )
  }
}

function ItemRow({
  item,
  open,
  toggle,
}: {
  item: TranscriptItem
  open: boolean
  toggle: () => void
}) {
  if (item.kind === 'turn') {
    return (
      <div className="pt-2">
        <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Turn {item.turn + 1}
        </div>
        <div className="flex gap-3">
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
            <UserRound className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1 rounded-lg bg-muted/60 px-3.5 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
            {item.prompt}
          </div>
        </div>
      </div>
    )
  }
  if (item.kind === 'turn-end') {
    return (
      <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <span>
          Turn {item.turn + 1} {item.status} in {formatDuration(item.durationMs)}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
    )
  }
  const e = item.event as EventLine
  return (
    <div className="flex gap-2">
      <span className="tabular w-14 shrink-0 pt-2 text-right font-mono text-[10px] text-muted-foreground/70">
        {offset(e.atMs)}
      </span>
      <div className="min-w-0 flex-1">
        <EventRow e={e} open={open} toggle={toggle} />
      </div>
    </div>
  )
}

const foldable = (item: TranscriptItem) =>
  item.kind === 'event' && (item.event.type === 'tool' || item.event.type === 'reasoning')

export function Transcript({ text }: { text: string }) {
  const items = useMemo(() => transcriptItems(parseTranscript(text)), [text])
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    setMargin((listRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY)
  }, [])
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => 56,
    overscan: 8,
    scrollMargin: margin,
  })
  const toggle = useCallback(
    (i: number) =>
      setOpen((prev) => {
        const next = new Set(prev)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        return next
      }),
    [],
  )
  const counts = useMemo(() => {
    let tools = 0
    let reasoning = 0
    let edits = 0
    for (const item of items) {
      if (item.kind !== 'event') continue
      if (item.event.type === 'tool') tools++
      if (item.event.type === 'reasoning') reasoning++
      if (item.event.type === 'file-edit') edits++
    }
    return { tools, reasoning, edits }
  }, [items])
  const foldables = items.flatMap((item, i) => (foldable(item) ? [i] : []))
  const allOpen = foldables.length > 0 && foldables.every((i) => open.has(i))

  if (items.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">The transcript is empty.</p>
    )
  }
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{counts.tools} tool calls</Badge>
        <Badge variant="secondary">{counts.edits} file edits</Badge>
        <Badge variant="secondary">{counts.reasoning} reasoning blocks</Badge>
        {foldables.length ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setOpen(allOpen ? new Set() : new Set(foldables))}
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </Button>
        ) : null}
      </div>
      <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index] as TranscriptItem
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full pb-2.5"
              style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
            >
              <ItemRow item={item} open={open.has(row.index)} toggle={() => toggle(row.index)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
