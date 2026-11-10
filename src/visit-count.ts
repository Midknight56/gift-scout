export const VISIT_ROW_CAP = 300

export type VisitKind = 'page' | 'api'
export type VisitVia = 'judges' | 'none'

function sourceFromReferer(referer: string | null): string {
  if (!referer) return 'none'
  try {
    const host = new URL(referer).hostname.toLowerCase()
    if (host === 'devpost.com' || host.endsWith('.devpost.com')) return 'devpost'
    if (host === 'github.com') return 'github'
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube'
    return 'other'
  } catch {
    return 'none'
  }
}

export function visitKind(req: Request): VisitKind | null {
  const path = new URL(req.url).pathname
  if (req.method === 'GET' && path === '/') return 'page'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && path.startsWith('/api/')) return 'api'
  return null
}

export function visitTag(req: Request, kind: VisitKind): { via: VisitVia; src: string } {
  const referer = req.headers.get('Referer')
  if (kind === 'page') {
    return {
      via: new URL(req.url).searchParams.get('via') === 'judges' ? 'judges' : 'none',
      src: sourceFromReferer(referer),
    }
  }
  try {
    if (!referer) return { via: 'none', src: 'none' }
    const ref = new URL(referer)
    if (ref.origin === new URL(req.url).origin) {
      return { via: ref.searchParams.get('via') === 'judges' ? 'judges' : 'none', src: 'self' }
    }
    return { via: 'none', src: sourceFromReferer(referer) }
  } catch {
    return { via: 'none', src: 'none' }
  }
}

export function isBot(req: Request): boolean {
  const agent = req.headers.get('User-Agent')
  return !agent || /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|go-http|headless|lighthouse/i.test(agent)
}

export function shouldCount(req: Request): boolean {
  const kind = visitKind(req)
  if (!kind || isBot(req)) return false
  if (kind === 'page') return true
  const referer = req.headers.get('Referer')
  if (!referer) return false
  try {
    return new URL(referer).origin === new URL(req.url).origin
  } catch {
    return false
  }
}

export async function countVisit(req: Request, env: { LEDGER?: D1Database }, app: string): Promise<void> {
  try {
    const kind = visitKind(req)
    if (!kind || !shouldCount(req) || !env.LEDGER) return
    const { via, src } = visitTag(req, kind)
    const day = new Date().toISOString().slice(0, 10)
    await env.LEDGER.prepare(
      'INSERT INTO visit_counts (day, app, kind, via, src, n) VALUES (?1, ?2, ?3, ?4, ?5, 1) ON CONFLICT (day, app, kind, via, src) DO UPDATE SET n = n + 1 WHERE n < 300',
    ).bind(day, app, kind, via, src).run()
  } catch {
    return
  }
}
