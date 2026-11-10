import { describe, expect, it } from 'vitest'
import { countVisit, isBot, shouldCount, visitKind, visitTag } from '../../src/visit-count'

const request = (url: string, method = 'GET', headers: HeadersInit = {}) => new Request(url, {
  method,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', ...Object.fromEntries(new Headers(headers).entries()) },
})

describe('visit counts', () => {
  it('classifies only home page GET and write API calls', () => {
    expect(visitKind(request('https://gift.test/?via=judges'))).toBe('page')
    expect(visitKind(request('https://gift.test/', 'HEAD'))).toBeNull()
    expect(visitKind(request('https://gift.test/api/scout', 'POST'))).toBe('api')
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(visitKind(request('https://gift.test/api/scout', method))).toBeNull()
    expect(visitKind(request('https://gift.test/other', 'POST'))).toBeNull()
  })

  it('tags judge, Devpost, GitHub, and unreferenced page visits', () => {
    expect(visitTag(request('https://gift.test/?via=judges'), 'page')).toEqual({ via: 'judges', src: 'none' })
    expect(visitTag(request('https://gift.test/', 'GET', { Referer: 'https://www.devpost.com/projects/x' }), 'page')).toEqual({ via: 'none', src: 'devpost' })
    expect(visitTag(request('https://gift.test/', 'GET', { Referer: 'https://github.com/org/repo' }), 'page')).toEqual({ via: 'none', src: 'github' })
    expect(visitTag(request('https://gift.test/'), 'page')).toEqual({ via: 'none', src: 'none' })
    expect(visitTag(request('https://gift.test/', 'GET', { Referer: 'not a url' }), 'page')).toEqual({ via: 'none', src: 'none' })
  })

  it('carries judge attribution from a same origin API referer only', () => {
    const api = request('https://gift.test/api/scout', 'POST', { Referer: 'https://gift.test/?via=judges' })
    expect(visitTag(api, 'api')).toEqual({ via: 'judges', src: 'self' })
    expect(visitTag(request('https://gift.test/api/scout', 'POST', { Referer: 'https://devpost.com/project' }), 'api')).toEqual({ via: 'none', src: 'devpost' })
    expect(visitTag(request('https://gift.test/api/scout', 'POST', { Referer: 'invalid' }), 'api')).toEqual({ via: 'none', src: 'none' })
  })

  it('filters missing and automated user agents', () => {
    expect(isBot(new Request('https://gift.test/'))).toBe(true)
    expect(isBot(request('https://gift.test/', 'GET', { 'User-Agent': 'Googlebot' }))).toBe(true)
    expect(isBot(request('https://gift.test/'))).toBe(false)
  })

  it('counts only same origin API actions and browser page visits', () => {
    expect(shouldCount(request('https://gift.test/api/scout', 'POST', { Referer: 'https://outside.test/' }))).toBe(false)
    expect(shouldCount(request('https://gift.test/api/scout', 'POST'))).toBe(false)
    expect(shouldCount(request('https://gift.test/api/scout', 'POST', { Referer: 'https://gift.test/?via=judges' }))).toBe(true)
    expect(shouldCount(request('https://gift.test/?via=judges'))).toBe(true)
    expect(shouldCount(request('https://gift.test/', 'GET', { 'User-Agent': 'Googlebot' }))).toBe(false)
  })

  it('writes the daily aggregate with expected SQL and bindings', async () => {
    let sql = ''
    let bindings: unknown[] = []
    const ledger = { prepare: (statement: string) => ({ bind: (...values: unknown[]) => { sql = statement; bindings = values; return { run: async () => ({}) } } }) } as unknown as D1Database
    await countVisit(request('https://gift.test/?via=judges'), { LEDGER: ledger }, 'gift-scout')
    expect(sql).toContain('INSERT INTO visit_counts')
    expect(sql).toContain('ON CONFLICT')
    expect(sql).toContain('WHERE n < 300')
    expect(bindings).toEqual([new Date().toISOString().slice(0, 10), 'gift-scout', 'page', 'judges', 'none'])
  })

  it('resolves when the ledger fails', async () => {
    const ledger = { prepare: () => { throw new Error('database unavailable') } } as unknown as D1Database
    await expect(countVisit(request('https://gift.test/'), { LEDGER: ledger }, 'gift-scout')).resolves.toBeUndefined()
  })
})
