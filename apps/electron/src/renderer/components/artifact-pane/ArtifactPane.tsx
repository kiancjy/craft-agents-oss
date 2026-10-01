import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { ChevronDown, FileText, Globe, Image as ImageIcon, Table2, Workflow, X } from 'lucide-react'
import {
  MarkdownDatatableBlock,
  MarkdownDocBlock,
  MarkdownHtmlBlock,
  MarkdownImageBlock,
  MarkdownMermaidBlock,
  MarkdownPdfBlock,
  MarkdownSpreadsheetBlock,
  resolveArtifactSrc,
  type ArtifactRef,
  type ArtifactType,
} from '@craft-agent/ui'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { cn } from '@/lib/utils'
import {
  artifactPaneAtomFamily,
  bumpArtifactVersionAtom,
  closeArtifactPaneAtom,
  setActiveArtifactAtom,
  type StoredArtifact,
} from '@/atoms/artifact-pane'

const TYPE_ICONS: Record<ArtifactType, React.ComponentType<{ className?: string }>> = {
  'html-preview': Globe,
  'markdown-preview': FileText,
  'pdf-preview': FileText,
  'image-preview': ImageIcon,
  mermaid: Workflow,
  datatable: Table2,
  spreadsheet: Table2,
}

function ArtifactContent({ artifact, onUrlClick, onFileClick }: { artifact: StoredArtifact; onUrlClick?: (url: string) => void; onFileClick?: (path: string) => void }) {
  const props = { code: artifact.code, presentation: 'pane' as const, className: 'h-full' }
  switch (artifact.type) {
    case 'html-preview': return <MarkdownHtmlBlock {...props} />
    case 'markdown-preview': return <MarkdownDocBlock {...props} onUrlClick={onUrlClick} onFileClick={onFileClick} />
    case 'pdf-preview': return <MarkdownPdfBlock {...props} />
    case 'image-preview': return <MarkdownImageBlock {...props} />
    case 'mermaid': return <MarkdownMermaidBlock {...props} className="h-full p-4" />
    case 'datatable': return <MarkdownDatatableBlock {...props} />
    case 'spreadsheet': return <MarkdownSpreadsheetBlock {...props} />
  }
}

export function useArtifactFileRefresh(sessionId: string, artifact: StoredArtifact | null): boolean {
  const bump = useSetAtom(bumpArtifactVersionAtom)
  const [flash, setFlash] = React.useState(false)
  const lastContentRef = React.useRef<string | null>(null)
  const src = artifact ? resolveArtifactSrc(artifact) : null
  const key = artifact?.key ?? null

  React.useEffect(() => {
    lastContentRef.current = null
    if (!src) return
    let cancelled = false
    window.electronAPI.readFile(src).then((content) => {
      if (!cancelled) lastContentRef.current = content
    }).catch(() => {})
    return () => { cancelled = true }
  }, [src, key])

  React.useEffect(() => {
    if (!src || !key) return
    void window.electronAPI.watchSessionFiles(sessionId)
    const unsubscribe = window.electronAPI.onSessionFilesChanged((changedSessionId) => {
      if (changedSessionId !== sessionId) return
      window.electronAPI.readFile(src).then((content) => {
        if (lastContentRef.current === content) return
        lastContentRef.current = content
        bump({ sessionId, key })
        setFlash(true)
      }).catch(() => {})
    })
    return unsubscribe
  }, [sessionId, src, key, bump])

  React.useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(false), 1800)
    return () => clearTimeout(timer)
  }, [flash])

  return flash
}

export interface ArtifactPaneProps {
  sessionId: string
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}

export function ArtifactPane({ sessionId, onUrlClick, onFileClick }: ArtifactPaneProps) {
  const { t } = useTranslation()
  const state = useAtomValue(artifactPaneAtomFamily(sessionId))
  const close = useSetAtom(closeArtifactPaneAtom)
  const setActive = useSetAtom(setActiveArtifactAtom)
  const active = state.activeKey ? state.artifacts[state.activeKey] ?? null : null
  const flash = useArtifactFileRefresh(sessionId, active)

  if (!active) return null
  const Icon = TYPE_ICONS[active.type]
  const list = state.order.map((key) => state.artifacts[key]).filter((item): item is StoredArtifact => !!item)

  return (
    <div className="h-full flex flex-col bg-background border-l" data-artifact-pane={active.key}>
      <div className="flex items-center gap-1 px-2 h-10 border-b shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 min-w-0 flex-1 px-2 h-7 rounded-[6px] hover:bg-foreground/5 text-[13px] text-foreground text-left"
              title={t('artifact.switchArtifact')}
            >
              <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="truncate font-medium">{active.title}</span>
              <span
                className={cn(
                  'text-[11px] text-muted-foreground transition-opacity px-1.5 py-0.5 rounded-[4px] bg-foreground/5',
                  flash ? 'opacity-100' : 'opacity-0',
                )}
                data-artifact-updated={flash ? 'true' : 'false'}
              >
                {t('artifact.updated')}
              </span>
              {list.length > 1 && <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
            </button>
          </DropdownMenuTrigger>
          {list.length > 1 && (
            <StyledDropdownMenuContent align="start">
              {list.map((item) => {
                const ItemIcon = TYPE_ICONS[item.type]
                return (
                  <StyledDropdownMenuItem key={item.key} onClick={() => setActive({ sessionId, key: item.key })}>
                    <ItemIcon className="h-3.5 w-3.5" />
                    <span className={cn('flex-1 truncate', item.key === active.key && 'font-medium')}>{item.title}</span>
                  </StyledDropdownMenuItem>
                )
              })}
            </StyledDropdownMenuContent>
          )}
        </DropdownMenu>
        <HeaderIconButton
          icon={<X className="h-4 w-4" />}
          tooltip={t('artifact.closePane')}
          onClick={() => close({ sessionId })}
          data-artifact-close
        />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <ArtifactContent key={`${active.key}:${active.version}`} artifact={active} onUrlClick={onUrlClick} onFileClick={onFileClick} />
      </div>
    </div>
  )
}
