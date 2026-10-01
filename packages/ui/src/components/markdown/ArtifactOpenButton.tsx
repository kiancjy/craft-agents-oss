import * as React from 'react'
import { PanelRightOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { usePlatform } from '../../context/PlatformContext'
import { createArtifactRef, type ArtifactRef, type ArtifactType, type BlockPresentation } from './artifact-ref'

export function useArtifactRef(type: ArtifactType, code: string, presentation: BlockPresentation): ArtifactRef | null {
  const { onOpenArtifact, onRegisterArtifact } = usePlatform()
  const ref = React.useMemo(() => createArtifactRef(type, code), [type, code])
  const enabled = presentation === 'inline' && !!onOpenArtifact
  React.useEffect(() => {
    if (!enabled || !onRegisterArtifact) return
    onRegisterArtifact(ref)
  }, [enabled, onRegisterArtifact, ref])
  return enabled ? ref : null
}

export interface ArtifactOpenButtonProps {
  artifact: ArtifactRef | null
  className?: string
  alwaysVisible?: boolean
}

export function ArtifactOpenButton({ artifact, className, alwaysVisible = false }: ArtifactOpenButtonProps) {
  const { t } = useTranslation()
  const { onOpenArtifact } = usePlatform()
  if (!artifact || !onOpenArtifact) return null
  return (
    <button
      type="button"
      data-artifact-open={artifact.key}
      onClick={(event) => {
        event.stopPropagation()
        onOpenArtifact(artifact)
      }}
      className={cn(
        'p-1 rounded-[6px] transition-all select-none',
        'bg-background shadow-minimal',
        'text-muted-foreground/50 hover:text-foreground',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
        alwaysVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        className,
      )}
      title={t('artifact.openBesideChat')}
    >
      <PanelRightOpen className="w-3.5 h-3.5" />
    </button>
  )
}
