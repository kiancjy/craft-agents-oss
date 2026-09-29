import * as React from 'react'
import { MessageSquare } from 'lucide-react'
import { useTeamSummary } from './team-client'

/** Team access for Pages (fork addition): open thread count on a page tile. */
export function TeamThreadBadge({ workspaceId, pageSlug }: { workspaceId: string; pageSlug: string }) {
  const summary = useTeamSummary(workspaceId)
  const count = summary?.pages[pageSlug]?.openThreads ?? 0
  if (count === 0) return null
  const label = count === 1 ? '1 open comment thread' : `${count} open comment threads`
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] text-foreground/55" role="img" aria-label={label} title={label}>
      <MessageSquare className="h-3 w-3" aria-hidden />
      {count}
    </span>
  )
}
