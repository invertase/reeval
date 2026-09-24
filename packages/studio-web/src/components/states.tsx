import type { LucideIcon } from 'lucide-react'
import { CloudOff, SearchX } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { NotFoundError } from '@/lib/data'
import { cn } from '@/lib/utils'

export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center',
        className,
      )}
    >
      <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children ? (
        <div className="mt-1.5 max-w-md text-sm text-muted-foreground">{children}</div>
      ) : null}
    </div>
  )
}

export function ErrorState({ error, className }: { error: unknown; className?: string }) {
  if (error instanceof NotFoundError) {
    return (
      <EmptyState icon={SearchX} title="Not found" className={className}>
        This run or file isn't in the history. It may have been removed, or the link is from another
        checkout.
      </EmptyState>
    )
  }
  return (
    <EmptyState icon={CloudOff} title="Couldn't load this" className={className}>
      <span className="font-mono text-xs">{(error as Error)?.message ?? String(error)}</span>
    </EmptyState>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
      {children}
    </code>
  )
}

export function RowsSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} className="h-11 w-full" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  )
}

export function PageHeaderSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-8 w-96 max-w-full" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
  )
}
