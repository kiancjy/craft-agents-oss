import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlatformProvider } from '../../../context/PlatformContext'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

type BlockModule = typeof import('../index')
let blocks: Array<[string, React.ReactElement]> = []

beforeAll(async () => {
  const mod: BlockModule = await import('../index')
  blocks = [
    ['html-preview', <mod.MarkdownHtmlBlock code='{"src":"/tmp/a.html"}' />],
    ['markdown-preview', <mod.MarkdownDocBlock code='{"src":"/tmp/a.md"}' />],
    ['pdf-preview', <mod.MarkdownPdfBlock code='{"src":"/tmp/a.pdf"}' />],
    ['image-preview', <mod.MarkdownImageBlock code='{"src":"/tmp/a.png"}' />],
    ['mermaid', <mod.MarkdownMermaidBlock code={'graph LR\nA-->B'} />],
    ['datatable', <mod.MarkdownDatatableBlock code='{"columns":[{"key":"a","label":"A"}],"rows":[{"a":1}]}' />],
    ['spreadsheet', <mod.MarkdownSpreadsheetBlock code='{"columns":[{"key":"a","label":"A"}],"rows":[{"a":1}]}' />],
  ]
})

const OPEN_ATTR = 'data-artifact-open'

function render(node: React.ReactNode, withPlatformAction: boolean) {
  const readers = { onReadFile: async () => '', onReadFileDataUrl: async () => '', onReadFileBinary: async () => new Uint8Array() }
  const actions = withPlatformAction ? { ...readers, onOpenArtifact: () => {} } : readers
  return renderToStaticMarkup(<PlatformProvider actions={actions}>{node}</PlatformProvider>)
}


const BLOCK_NAMES = ['html-preview', 'markdown-preview', 'pdf-preview', 'image-preview', 'mermaid', 'datatable', 'spreadsheet']

function blockFor(name: string): React.ReactElement {
  const found = blocks.find(([blockName]) => blockName === name)
  if (!found) throw new Error(`no block registered for ${name}`)
  return found[1]
}

describe('open beside chat button', () => {
  it('covers every artifact block type', () => {
    expect(blocks.map(([name]) => name)).toEqual(BLOCK_NAMES)
  })

  for (const name of BLOCK_NAMES) {
    it(`${name} shows the button only when the platform can open artifacts`, () => {
      const element = blockFor(name)
      expect(render(element, true)).toContain(OPEN_ATTR)
      expect(render(element, false)).not.toContain(OPEN_ATTR)
    })

    it(`${name} hides the button and the fullscreen button when rendered inside the pane`, () => {
      const inPane = React.cloneElement(blockFor(name), { presentation: 'pane' })
      const markup = render(inPane, true)
      expect(markup).not.toContain(OPEN_ATTR)
      expect(markup).not.toContain('lucide-maximize-2')
    })
  }
})
