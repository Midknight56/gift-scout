import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const draw = source.slice(source.indexOf('function drawCards('), source.indexOf('function drawCompareButton('))
const handle = source.slice(source.indexOf('function handleEvent('), source.indexOf('async function submitMessage('))

class Element {
  children: Element[] = []
  parent: Element | null = null
  className = ''
  textContent = ''
  hidden = false
  dataset: Record<string, string> = {}
  style = { setProperty: () => {} }
  classList = {
    add: (value: string) => { if (!this.classList.contains(value)) this.className += ` ${value}` },
    contains: (value: string) => this.className.split(/\s+/).includes(value),
  }
  markup = ''
  set innerHTML(value: string) {
    this.replaceChildren()
    this.markup = value
    if (value === 'card') {
      const card = new Element(), actions = new Element(), form = new Element()
      card.className = 'gift-card'
      actions.className = 'card-actions'
      form.className = 'ship-form'
      actions.append(form)
      card.append(actions)
      this.append(card)
    }
  }
  get innerHTML() { return this.markup }
  get firstElementChild() { return this.children[0] }
  append(child: Element) { child.parent = this; this.children.push(child) }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
  replaceChildren() { this.children.forEach((child) => { child.parent = null }); this.children = []; this.markup = '' }
  querySelectorAll(selector: string): Element[] {
    const selectors = selector.split(',').map((part) => part.trim())
    return this.children.flatMap((child) => {
      const matches = selectors.some((part) => {
        const classes = [...part.matchAll(/\.([\w-]+)/g)].map((match) => match[1])
        const id = part.match(/\[data-card-id(?:="([^"]*)")?\]/)
        return classes.every((name) => child.classList.contains(name)) && (!id || (id[1] ? child.dataset.cardId === id[1] : Boolean(child.dataset.cardId)))
      })
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)]
    })
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
}

function page() {
  const chat = new Element(), walkPanel = new Element(), droppedList = new Element()
  const cards = new Map<string, { id: string }>()
  const lines: string[] = []
  const context = {
    chat, walkPanel, cards, droppedList, droppedWrap: { hidden: true },
    firstCardsReady: false, firstCardList: null, canBuy: true, conversation: 'conversation',
    document: { createElement: () => new Element() }, CSS: { escape: (value: string) => value },
    structuredClone, cardHtml: () => 'card', ownerFor: () => 'owner',
    walkSvg: (items: { id: string }[]) => items.map((item) => item.id).join(','),
    addLine: (_className: string, text: string) => { lines.push(text) },
    drawCompareButton: () => {}, scrollChat: () => {}, collapseEarlier: () => {}, drawLeaveOut: () => {}, leaveOutResult: () => {},
  }
  runInNewContext(`${draw}\n${handle}\nthis.handle = handleEvent`, context)
  const handleEvent = (context as typeof context & { handle: (event: unknown, options?: { live: boolean }) => void }).handle
  handleEvent({ t: 'cards', cards: [{ id: 'old' }, { id: 'kept' }], dropped: [] })
  return { ...context, lines, handleEvent }
}

describe('cards taken back on the page', () => {
  it.each([true, false])('withdraws cards and their open pay form for live=%s', (live) => {
    const pageState = page()
    const { chat, cards, handleEvent, walkPanel } = pageState
    const card = chat.querySelector('[data-card-id="old"]')!
    expect(card.querySelector('.ship-form')).not.toBeNull()
    handleEvent({ t: 'cards_withdrawn', cards: ['old'], names: ['Aspen'] }, { live })
    expect(card.classList.contains('withdrawn')).toBe(true)
    expect(card.querySelector('.card-actions')).toBeNull()
    expect(card.querySelector('.ship-form')).toBeNull()
    expect(card.children.some((child) => child.textContent === 'Taken back')).toBe(true)
    expect(cards.has('old')).toBe(false)
    expect(cards.has('kept')).toBe(true)
    expect(chat.querySelector('[data-card-id="kept"]')!.querySelector('.card-actions')).not.toBeNull()
    expect(walkPanel.innerHTML).toBe('kept')
    expect(walkPanel.hidden).toBe(false)
  })

  it('hides and clears the graph after the last current card is withdrawn', () => {
    const { handleEvent, walkPanel, cards } = page()
    handleEvent({ t: 'cards_withdrawn', cards: ['old', 'kept'], names: ['Aspen'] })
    expect(cards.size).toBe(0)
    expect(walkPanel.hidden).toBe(true)
    expect(walkPanel.innerHTML).toBe('')
  })

  it('removes every pay action and marks earlier lists on an empty cards event', () => {
    const { handleEvent, chat, walkPanel, lines } = page()
    handleEvent({ t: 'cards', cards: [], dropped: [] })
    expect(chat.querySelectorAll('.card-actions')).toHaveLength(0)
    expect(chat.querySelectorAll('.ship-form')).toHaveLength(0)
    expect(chat.querySelectorAll('.card-list').every((list) => list.classList.contains('earlier'))).toBe(true)
    expect(walkPanel.hidden).toBe(true)
    expect(walkPanel.innerHTML).toBe('')
    expect(lines).toEqual(['No new ideas this time. Ask again with other things they love.'])
  })

  it('redraws the graph only from the latest cards after a withdrawal', () => {
    const { handleEvent, cards, walkPanel } = page()
    handleEvent({ t: 'cards', cards: [{ id: 'current' }], dropped: [] })
    handleEvent({ t: 'cards_withdrawn', cards: ['old'], names: ['Aspen'] })
    expect([...cards.keys()]).toEqual(['current'])
    expect(walkPanel.innerHTML).toBe('current')
  })
})
