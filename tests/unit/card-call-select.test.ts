import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8')

interface FakeEl {
  attrs: Record<string, string>; dataset: Record<string, string>; kids: FakeEl[]
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean }
  getAttribute(name: string): string | null; matches(selector: string): boolean; all(): FakeEl[]
  querySelector(selector: string): FakeEl | null; querySelectorAll(selector: string): FakeEl[]
}

/** A tiny element: a class list, a dataset, attributes and the children a selector can find. */
function el(attrs: Record<string, string> = {}, cls: string[] = []): FakeEl {
  const classes = new Set(cls)
  const node: FakeEl = {
    attrs, dataset: {}, kids: [],
    classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) }, contains: (c: string) => classes.has(c) },
    getAttribute: (name: string) => attrs[name] ?? null,
    matches(selector: string): boolean {
      return selector.split(',').some((part) => {
        const s = part.trim()
        const attr = s.match(/\[([\w-]+)(?:="([^"]*)")?\]/)
        const klass = [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1])
        if (attr && (attr[2] === undefined ? !(attr[1] in attrs) : attrs[attr[1]] !== attr[2])) return false
        return klass.every((k) => classes.has(k))
      })
    },
    all(): FakeEl[] { return node.kids.flatMap((k) => [k, ...k.all()]) },
    querySelector(selector: string) { return node.all().find((k) => k.matches(selector)) ?? null },
    querySelectorAll(selector: string) { return node.all().filter((k) => k.matches(selector)) },
  }
  return node
}

function slice(name: string): string {
  const start = app.indexOf(`function ${name}(`)
  const end = app.slice(start).search(/\r?\n\}\r?\n/)
  return app.slice(start, start + end) + '\n}\n'
}

function setup() {
  const walkPanel = el(); const chat = el(); const callsList = el()
  const row3 = el({ 'data-call-row': '3' }, ['call-row']); const row5 = el({ 'data-call-row': '5' }, ['call-row'])
  callsList.kids.push(row3, row5)
  const link = el({ 'data-call': '3' }, ['call-link'])
  const card = el({}, ['gift-card']); card.dataset.cardIndex = '1'; card.kids.push(link)
  chat.kids.push(card)
  const context = { walkPanel, chat, callsList, CSS: { escape: (s: string) => s } }
  vm.runInNewContext(`${slice('clearSelection')}\n${slice('selectCard')}\nthis.selectCard = selectCard; this.clearSelection = clearSelection;`, context)
  return { ...(context as unknown as { selectCard(c: unknown): void; clearSelection(): void }), card, row3, row5 }
}

describe('selecting a card lights its call row too', () => {
  it('marks the call row behind the selected card and no other', () => {
    const t = setup()
    t.selectCard(t.card)
    expect(t.row3.classList.contains('is-selected')).toBe(true)
    expect(t.row5.classList.contains('is-selected')).toBe(false)
  })

  it('clears the call row when the selection clears', () => {
    const t = setup()
    t.selectCard(t.card)
    t.clearSelection()
    expect(t.row3.classList.contains('is-selected')).toBe(false)
  })

  it('styles a selected call row like a highlighted one', () => {
    expect(css).toMatch(/\.call-row\.is-selected[^{]*\{[^}]*border-color: var\(--accent\)/)
  })
})
