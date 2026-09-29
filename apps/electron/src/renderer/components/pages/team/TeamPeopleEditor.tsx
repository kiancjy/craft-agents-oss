import * as React from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  type GeneralRuleName,
  type TeamPeopleView,
  type TeamRoleName,
  invalidateTeamSummary,
  pagePath,
  teamCall,
} from './team-client'

/**
 * Team access for Pages (fork addition): people, roles, the general rule,
 * and the team link for one page. Used in the Share dialog and in the
 * People tab of the comment panel. The Owner acts through the owner port;
 * the team server checks and records every change.
 */

const ROLE_OPTIONS: Array<[TeamRoleName, string]> = [
  ['viewer', 'Viewer'],
  ['commenter', 'Commenter'],
  ['editor', 'Editor'],
  ['admin', 'Admin'],
]
const RULE_OPTIONS: Array<[GeneralRuleName, string]> = [
  ['none', 'No access'],
  ['viewer', 'Viewer'],
  ['commenter', 'Commenter'],
]

const selectClass =
  'h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-ring'

interface TeamPeopleEditorProps {
  workspaceId: string
  pageSlug: string
  /** Team link from the team server, if a public address is set */
  teamLink?: string | null
}

export function TeamPeopleEditor({ workspaceId, pageSlug, teamLink }: TeamPeopleEditorProps) {
  const [view, setView] = React.useState<TeamPeopleView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [unavailable, setUnavailable] = React.useState<string | null>(null)
  const [email, setEmail] = React.useState('')
  const [role, setRole] = React.useState<TeamRoleName>('viewer')
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const apply = React.useCallback(
    async (method: string, rest: string, body?: unknown) => {
      setBusy(true)
      const result = await teamCall<TeamPeopleView>(workspaceId, method, pagePath(pageSlug, rest), body)
      setBusy(false)
      if (result.kind === 'unavailable') {
        setUnavailable(result.reason)
        return false
      }
      if (result.kind === 'error') {
        setError(result.message)
        return false
      }
      setUnavailable(null)
      setError(null)
      setView(result.data)
      if (method !== 'GET') invalidateTeamSummary(workspaceId)
      return true
    },
    [workspaceId, pageSlug],
  )

  React.useEffect(() => {
    void apply('GET', '/people')
  }, [apply])

  const add = async () => {
    const value = email.trim()
    if (!value) return
    if (await apply('PUT', '/people', { email: value, role })) setEmail('')
  }

  if (unavailable) {
    return <p className="text-xs text-foreground/50">Team access is not available: {unavailable}</p>
  }
  if (!view) {
    return <p className="text-xs text-foreground/50">Loading…</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground/70">Add a person</span>
        <div className="flex items-center gap-2">
          <Input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void add()
            }}
            placeholder={`name@${view.allowedDomain}`}
            className="h-8 text-xs"
          />
          <select className={selectClass} value={role} onChange={e => setRole(e.target.value as TeamRoleName)}>
            {ROLE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => void add()} disabled={busy || !email.trim()}>
            Add
          </Button>
        </div>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground/70">Everyone at {view.allowedDomain}</span>
        <select
          className={selectClass}
          value={view.generalRule}
          disabled={busy}
          onChange={e => void apply('PUT', '/general-rule', { rule: e.target.value })}
        >
          {RULE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border/60">
        <li className="flex items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            {view.owner.name} <span className="text-foreground/50">{view.owner.email}</span>
          </span>
          <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/60">Owner</span>
        </li>
        {view.people.map(person => (
          <li key={person.email} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate" title={person.email}>
              {person.email}
            </span>
            <select
              className={selectClass}
              value={person.role}
              disabled={busy}
              onChange={e => void apply('PUT', '/people', { email: person.email, role: e.target.value })}
            >
              {ROLE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={`Remove ${person.email}`}
              title="Remove"
              disabled={busy}
              onClick={() => void apply('DELETE', `/people?email=${encodeURIComponent(person.email)}`)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/5 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {teamLink ? (
        <div className="flex items-center gap-2">
          <Input readOnly value={teamLink} className="h-8 font-mono text-xs" onFocus={e => e.currentTarget.select()} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(teamLink).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy team link'}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-foreground/50">The team link appears here after the Cloudflare setup.</p>
      )}
    </div>
  )
}
