import * as React from 'react'
import { MessageSquare, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TeamPeopleEditor } from './TeamPeopleEditor'
import {
  type TeamComment,
  type TeamPageState,
  type TeamThread,
  formatTeamTime,
  invalidateTeamSummary,
  pagePath,
  teamCall,
  useTeamPanelOpen,
  useTeamSummary,
} from './team-client'

/**
 * Team access for Pages (fork addition): the Owner's comment panel beside
 * the page. Same threads as the team link. The Owner can comment, reply,
 * edit and delete own comments, resolve and reopen any thread, and manage
 * people in the People tab.
 */

const POLL_MS = 15_000

/** Header button. Hidden when the team server is not set up on this machine. */
export function TeamCommentsButton({ workspaceId, pageSlug }: { workspaceId: string; pageSlug: string }) {
  const summary = useTeamSummary(workspaceId)
  const [open, setOpen] = useTeamPanelOpen(pageSlug)
  if (!summary) return null
  const count = summary.pages[pageSlug]?.openThreads ?? 0
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-label="Team comments"
      aria-pressed={open}
      title="Team comments"
      className={
        'flex h-7 items-center gap-1.5 rounded-md px-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground' +
        (open ? ' bg-foreground/5 text-foreground' : '')
      }
    >
      <MessageSquare className="h-4 w-4" />
      {count > 0 && <span className="text-xs">{count}</span>}
    </button>
  )
}

export function TeamCommentsPanel({ workspaceId, pageSlug }: { workspaceId: string; pageSlug: string }) {
  const [open, setOpen] = useTeamPanelOpen(pageSlug)
  if (!open) return null
  return <PanelBody workspaceId={workspaceId} pageSlug={pageSlug} onClose={() => setOpen(false)} />
}

function PanelBody({ workspaceId, pageSlug, onClose }: { workspaceId: string; pageSlug: string; onClose: () => void }) {
  const [tab, setTab] = React.useState<'comments' | 'people'>('comments')
  const [state, setState] = React.useState<TeamPageState | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [showResolved, setShowResolved] = React.useState(false)

  const load = React.useCallback(async () => {
    const result = await teamCall<TeamPageState>(workspaceId, 'GET', pagePath(pageSlug, '/state'))
    if (result.kind === 'ok') {
      setState(result.data)
      setProblem(null)
    } else {
      setProblem(result.kind === 'unavailable' ? result.reason : result.message)
    }
  }, [workspaceId, pageSlug])

  React.useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  /** Run one change; on success reload the threads and the counts. Returns an error text or null. */
  const change = React.useCallback(
    async (method: string, rest: string, body?: unknown): Promise<string | null> => {
      const result = await teamCall(workspaceId, method, pagePath(pageSlug, rest), body)
      if (result.kind !== 'ok') return result.kind === 'unavailable' ? 'Not sent. Try again.' : result.message
      await load()
      invalidateTeamSummary(workspaceId)
      return null
    },
    [workspaceId, pageSlug, load],
  )

  const open = state?.threads.filter(t => t.resolvedAt === null).reverse() ?? []
  const resolved = state?.threads.filter(t => t.resolvedAt !== null).reverse() ?? []

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border/50 bg-background">
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        {(['comments', 'people'] as const).map(name => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={
              'h-7 rounded-md px-2 text-xs font-medium transition-colors ' +
              (tab === name ? 'bg-foreground/5 text-foreground' : 'text-foreground/55 hover:text-foreground')
            }
          >
            {name === 'comments' ? `Comments${open.length ? ` (${open.length})` : ''}` : 'People'}
          </button>
        ))}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/5 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {problem && !state ? (
          <p className="text-xs text-foreground/55">Team comments are not available: {problem}</p>
        ) : !state ? (
          <p className="text-xs text-foreground/55">Loading…</p>
        ) : tab === 'people' ? (
          <TeamPeopleEditor workspaceId={workspaceId} pageSlug={pageSlug} teamLink={state.teamLink} />
        ) : (
          <div className="flex flex-col gap-3">
            {problem && <p className="text-xs text-destructive">{problem}</p>}
            <Composer placeholder="Add a comment" label="Comment" onSend={text => change('POST', '/threads', { body: text })} />
            {open.length === 0 && <p className="text-xs text-foreground/50">No open comments.</p>}
            {open.map(thread => (
              <ThreadCard key={thread.id} thread={thread} me={state.me.email} change={change} />
            ))}
            {resolved.length > 0 && (
              <button
                type="button"
                className="self-start text-xs text-foreground/55 hover:text-foreground"
                onClick={() => setShowResolved(v => !v)}
              >
                {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
              </button>
            )}
            {showResolved &&
              resolved.map(thread => <ThreadCard key={thread.id} thread={thread} me={state.me.email} change={change} />)}
          </div>
        )}
      </div>
    </aside>
  )
}

type Change = (method: string, rest: string, body?: unknown) => Promise<string | null>

function Composer({
  placeholder,
  label,
  initial = '',
  onSend,
  onCancel,
}: {
  placeholder: string
  label: string
  initial?: string
  onSend: (text: string) => Promise<string | null>
  onCancel?: () => void
}) {
  const [text, setText] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const send = async () => {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    const failure = await onSend(value)
    setBusy(false)
    setError(failure)
    if (!failure) setText('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={text}
        onChange={e => {
          setText(e.target.value)
          setError(null)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
        }}
        placeholder={placeholder}
        maxLength={5000}
        rows={2}
        className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
      />
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-destructive">{error}</span>}
        <span className="flex-1" />
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={() => void send()} disabled={busy || !text.trim()}>
          {label}
        </Button>
      </div>
    </div>
  )
}

function ThreadCard({ thread, me, change }: { thread: TeamThread; me: string; change: Change }) {
  const resolved = thread.resolvedAt !== null
  return (
    <section className={'flex flex-col gap-2 rounded-lg border border-border/60 p-2.5' + (resolved ? ' opacity-75' : '')}>
      {thread.comments.map(comment => (
        <CommentRow key={comment.id} comment={comment} mine={comment.authorEmail === me} change={change} />
      ))}
      <div className="flex items-center gap-2">
        {resolved && <span className="text-[11px] text-foreground/50">Resolved {formatTeamTime(thread.resolvedAt!)}</span>}
        <button
          type="button"
          className="ml-auto text-xs text-foreground/55 hover:text-foreground"
          onClick={() => void change('POST', `/threads/${thread.id}/resolve`, { resolved: !resolved })}
        >
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
      {!resolved && (
        <Composer placeholder="Reply" label="Reply" onSend={text => change('POST', `/threads/${thread.id}/replies`, { body: text })} />
      )}
    </section>
  )
}

function CommentRow({ comment, mine, change }: { comment: TeamComment; mine: boolean; change: Change }) {
  const [editing, setEditing] = React.useState(false)
  const meta = (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-medium">{comment.authorName}</span>
      <span className="text-[11px] text-foreground/45">
        {formatTeamTime(comment.createdAt)}
        {comment.editedAt ? ' (edited)' : ''}
      </span>
    </div>
  )
  if (comment.deleted) {
    return (
      <div className="flex flex-col gap-0.5">
        {meta}
        <span className="text-xs text-foreground/45">Comment deleted.</span>
      </div>
    )
  }
  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        {meta}
        <Composer
          placeholder="Edit comment"
          label="Save"
          initial={comment.body}
          onCancel={() => setEditing(false)}
          onSend={async text => {
            const failure = await change('PATCH', `/comments/${comment.id}`, { body: text })
            if (!failure) setEditing(false)
            return failure
          }}
        />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      {meta}
      <p className="whitespace-pre-wrap break-words text-xs text-foreground/85">{comment.body}</p>
      {mine && (
        <div className="flex gap-3">
          <button type="button" className="text-[11px] text-foreground/50 hover:text-foreground" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className="text-[11px] text-foreground/50 hover:text-foreground"
            onClick={() => void change('DELETE', `/comments/${comment.id}`)}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
