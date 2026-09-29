import * as React from 'react'
import { Users } from 'lucide-react'
import type { LoadedPage } from '@craft-agent/shared/pages/types'
import { TeamPeopleEditor } from './TeamPeopleEditor'
import { useTeamSummary } from './team-client'

/**
 * Team access for Pages (fork addition): the Team section of the Share
 * dialog, below the public link section. Hidden when the team server is not
 * set up on this machine, so the dialog stays as upstream built it.
 */
export function TeamAccessSection({ workspaceId, page }: { workspaceId: string; page: LoadedPage }) {
  const summary = useTeamSummary(workspaceId)
  if (!summary) return null
  const teamLink = summary.pages[page.config.slug]?.teamLink ?? null
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-foreground/60" />
        <span className="text-sm font-medium">Team</span>
      </div>
      <p className="-mt-1 text-xs text-foreground/60">
        People at Incredible sign in with Google and open this page at the team link. The public link does not change.
      </p>
      <TeamPeopleEditor workspaceId={workspaceId} pageSlug={page.config.slug} teamLink={teamLink} />
    </div>
  )
}
