import { FileDiff } from 'lucide-react'
import { useMemo, useState } from 'react'
import { type PatchFile, splitPatch } from 'reeval/view'
import { EmptyState } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const MAX_LINES = 5000

function lineClass(line: string) {
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'text-muted-foreground'
  if (line.startsWith('+')) return 'bg-pass/10 text-pass'
  if (line.startsWith('-')) return 'bg-fail/10 text-fail'
  if (line.startsWith('@@')) return 'bg-brand/8 text-brand'
  if (/^(diff --git|index |new file|deleted file|similarity|rename )/.test(line))
    return 'text-muted-foreground'
  return ''
}

export function PatchView({ text, className }: { text: string; className?: string }) {
  const lines = text.split('\n')
  const shown = lines.slice(0, MAX_LINES)
  return (
    <div className={cn('overflow-auto rounded-lg border bg-card', className)}>
      <pre className="min-w-fit py-2 font-mono text-xs leading-5">
        {shown.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of an immutable file
          <div key={i} className={cn('px-4 whitespace-pre', lineClass(line))}>
            {line || ' '}
          </div>
        ))}
      </pre>
      {lines.length > MAX_LINES ? (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Showing the first {MAX_LINES} of {lines.length} lines.
        </p>
      ) : null}
    </div>
  )
}

const STATUS: Record<PatchFile['status'], string> = {
  added: 'text-pass',
  deleted: 'text-fail',
  modified: 'text-infra',
  renamed: 'text-drift',
  binary: 'text-muted-foreground',
}

export function Diff({ text }: { text: string }) {
  const files = useMemo(() => splitPatch(text), [text])
  const [selected, setSelected] = useState(0)
  if (files.length === 0) {
    return (
      <EmptyState icon={FileDiff} title="No changes">
        The agent didn't change any files in the workspace.
      </EmptyState>
    )
  }
  const file = files[Math.min(selected, files.length - 1)] as PatchFile
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
          <span>{files.length} files</span>
          <span className="font-mono">
            <span className="text-pass">+{added}</span>{' '}
            <span className="text-fail">−{removed}</span>
          </span>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          {files.map((f, i) => (
            <button
              key={f.path}
              type="button"
              onClick={() => setSelected(i)}
              className={cn(
                'flex w-full items-center gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent/50',
                i === selected && 'bg-accent',
              )}
            >
              <span className={cn('text-[10px] font-semibold uppercase', STATUS[f.status])}>
                {f.status[0]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
              <span className="shrink-0 font-mono text-[11px]">
                <span className="text-pass">+{f.added}</span>{' '}
                <span className="text-fail">−{f.removed}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm">{file.path}</span>
          <Badge variant="outline" className={STATUS[file.status]}>
            {file.status}
          </Badge>
        </div>
        <PatchView text={file.text} className="max-h-[70vh]" />
      </div>
    </div>
  )
}
