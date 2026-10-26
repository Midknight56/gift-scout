import type { ScoutEvent } from '../agent/events'

export interface SharePreview {
  title: string
  description: string
}

const FALLBACK_DESCRIPTION = 'Gift ideas from what a person already loves, through Qloo.'

interface RewriteElement {
  setAttribute(name: string, value: string): void
  setInnerContent(value: string, options?: { html?: boolean }): void
  append(value: string, options?: { html?: boolean }): void
  remove(): void
}
interface RewriterInstance {
  on(selector: string, handlers: { element(element: RewriteElement): void }): RewriterInstance
  transform(response: Response): Response
}

function cutAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text
  const prefix = text.slice(0, limit - 3)
  const boundary = prefix.lastIndexOf(' ')
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}...`
}

export function previewFor(turns: ScoutEvent[][]): SharePreview {
  const firstRun = turns.flat().find((event): event is Extract<ScoutEvent, { t: 'run' }> => event.t === 'run')
  const title = cutAtWord(`Gift Scout: ${firstRun?.said ?? ''}`, 70)
  let latestCards: Extract<ScoutEvent, { t: 'cards' }> | undefined
  for (const turn of turns) {
    for (const event of turn) {
      if (event.t === 'cards' && event.cards.length) latestCards = event
    }
  }
  const description = latestCards
    ? cutAtWord(`Ideas: ${latestCards.cards.slice(0, 3).map((card) => card.gift).join(', ')}`, 160)
    : FALLBACK_DESCRIPTION
  return { title, description }
}

export function sharePage(assetResponse: Response, preview: SharePreview): Response {
  const Rewriter = (globalThis as typeof globalThis & { HTMLRewriter: new () => RewriterInstance }).HTMLRewriter
  const placeholders = new Rewriter()
    .on('title', { element: (element) => { element.setInnerContent(preview.title, { html: false }) } })
    .on('head', {
      element: (element) => {
        element.append(
          '<meta name="description"><meta property="og:title"><meta property="og:description"><meta property="og:type">',
          { html: true },
        )
      },
    })
    .transform(assetResponse)
  const seen = { description: false, title: false, ogDescription: false, type: false }
  const response = new Rewriter()
    .on('meta[name="description"]', { element: (element) => {
      if (seen.description) element.remove()
      else { seen.description = true; element.setAttribute('content', preview.description) }
    } })
    .on('meta[property="og:title"]', { element: (element) => {
      if (seen.title) element.remove()
      else { seen.title = true; element.setAttribute('content', preview.title) }
    } })
    .on('meta[property="og:description"]', { element: (element) => {
      if (seen.ogDescription) element.remove()
      else { seen.ogDescription = true; element.setAttribute('content', preview.description) }
    } })
    .on('meta[property="og:type"]', { element: (element) => {
      if (seen.type) element.remove()
      else { seen.type = true; element.setAttribute('content', 'website') }
    } })
    .transform(placeholders)
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
