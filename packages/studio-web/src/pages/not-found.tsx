import { Link } from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { EmptyState } from '@/components/states'

export function NotFoundPage() {
  return (
    <EmptyState icon={Compass} title="Page not found">
      That link doesn't point anywhere in the studio.{' '}
      <Link to="/" className="underline">
        Go to runs
      </Link>
    </EmptyState>
  )
}
