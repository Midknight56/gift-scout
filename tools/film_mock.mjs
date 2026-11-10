// Film mock for rehearsing the tour without a live model, PayPal or neurons.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export async function installMock(page, dir = 'docs/film-mock') {
  const zyPath = resolve(dir, 'Zy56eVwNcGgw.turns.json')
  const zaiPath = resolve(dir, 'ZAi5yAyt4oWg.turns.json')
  const zy = JSON.parse(readFileSync(zyPath, 'utf8'))
  const zai = JSON.parse(readFileSync(zaiPath, 'utf8'))

  let scoutIndex = 0
  let boughtCard = 't3c1'

  const zy0 = structuredClone(zy[0])
  const run0 = zy0.find((e) => e.t === 'run')
  if (run0) run0.conversation = 'filmmock1'
  const run0Index = zy0.findIndex((e) => e.t === 'run')
  zy0.splice(run0Index + 1, 0, { t: 'owner', token: 'mock-owner' })
  zy0.push({ t: 'done', share: '/s/filmmock1' })

  const zy2 = structuredClone(zy[2])
  const run2 = zy2.find((e) => e.t === 'run')
  if (run2) run2.conversation = 'filmmock1'
  zy2.push({ t: 'done', share: '/s/filmmock1' })

  const run3 = structuredClone(zy[3].find((e) => e.t === 'run'))
  if (run3) run3.conversation = 'filmmock1'
  const withdrawn3 = structuredClone(zy[3].find((e) => e.t === 'cards_withdrawn'))
  const say3 = structuredClone(zy[3].find((e) => e.t === 'say'))
  const cardsEvent = structuredClone(zai[1].find((e) => e.t === 'cards'))
  if (cardsEvent?.cards) {
    cardsEvent.cards.forEach((card, index) => {
      card.id = `t3c${index + 1}`
    })
  }
  const usage3 = structuredClone(zy[3].find((e) => e.t === 'usage'))
  const leaveOutTurn = [run3, withdrawn3, say3, cardsEvent, usage3, { t: 'done', share: '/s/filmmock1' }].filter(Boolean)

  const scoutAnswers = [zy0, zy2, leaveOutTurn]

  const ndjson = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'

  await page.exposeFunction('__filmMockStream', async (path, bodyText) => {
    if (path === '/api/scout') {
      const turn = scoutAnswers[scoutIndex] ?? scoutAnswers.at(-1)
      scoutIndex++
      return { status: 200, events: turn }
    }

    if (path === '/api/compare') {
      const compareTurn = structuredClone(zy[1])
      const run = compareTurn.find((e) => e.t === 'run')
      if (run) run.conversation = 'filmmock1'
      compareTurn.push({ t: 'done', share: '/s/filmmock1' })
      return { status: 200, events: compareTurn }
    }

    if (path === '/api/buy') {
      let body = {}
      try {
        body = JSON.parse(bodyText || '{}')
      } catch {}

      if (!body.card || !body.conversation) {
        return { status: 400, error: 'Send a conversation and a card.' }
      }

      const cardId = body.card
      boughtCard = cardId

      if (!body.method) {
        const run = { t: 'run', conversation: 'filmmock1', turn: 2, mode: 'live', said: 'Buy this one: Paperback copy of The Difference Engine', purpose: 'buy' }
        const call = { t: 'call', n: 17, tool: 'buy_gift', args: { card_id: cardId, amount_usd: 15 } }
        const result = { t: 'result', n: 17, tool: 'buy_gift', ok: true, ms: 1200, cached: false, text: 'PayPal sandbox order 1RP84723JX9338815 for $15.00, waiting for the buyer to approve.', top: [] }
        const order = { t: 'order', card: cardId, gift: 'Paperback copy of The Difference Engine', order_id: '1RP84723JX9338815', amount: '15.00', method: 'paypal', approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=1RP84723JX9338815' }
        const usage = { t: 'usage', model_calls: 1, neurons: 5.9 }
        const done = { t: 'done', share: '/s/filmmock1' }
        return { status: 200, events: [run, call, result, order, usage, done] }
      }

      const buyTurn = structuredClone(zai[2]).filter((e) => e.t !== 'refunded')
      for (const event of buyTurn) {
        if (event.t === 'run') event.conversation = 'filmmock1'
        if ('card' in event) event.card = cardId
        if (event.args && 'card_id' in event.args) event.args.card_id = cardId
        if (event.t === 'order' && body.method) event.method = body.method
      }
      buyTurn.push({ t: 'done', share: '/s/filmmock1' })
      return { status: 200, events: buyTurn }
    }

    return null
  })

  await page.addInitScript(() => {
    const origFetch = window.fetch
    window.fetch = async (url, opts) => {
      const u = typeof url === 'string' ? url : url?.url || ''
      const path = new URL(u, location.href).pathname.replace(/\/$/, '')
      const method = (opts?.method || 'GET').toUpperCase()

      if (method === 'POST' && ['/api/scout', '/api/compare', '/api/buy'].includes(path)) {
        const res = await window.__filmMockStream(path, opts?.body)
        if (!res) return origFetch(url, opts)
        if (res.status !== 200) {
          return new Response(JSON.stringify({ error: res.error }), {
            status: res.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          })
        }
        const events = res.events
        const enc = new TextEncoder()
        const stream = new ReadableStream({
          async start(controller) {
            for (const event of events) {
              const waitMs = event.t === 'result'
                ? Math.max(120, Math.min(3000, typeof event.ms === 'number' ? event.ms : 120))
                : 120
              await new Promise((r) => setTimeout(r, waitMs))
              controller.enqueue(enc.encode(JSON.stringify(event) + '\n'))
            }
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      }

      return origFetch(url, opts)
    }
  })

  await page.route('**/*', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const path = url.pathname.replace(/\/$/, '')

    if (method === 'POST' && path === '/api/scout') {
      const turn = scoutAnswers[scoutIndex] ?? scoutAnswers.at(-1)
      scoutIndex++
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: ndjson(turn),
      })
      return
    }

    if (method === 'POST' && path === '/api/compare') {
      const compareTurn = structuredClone(zy[1])
      const run = compareTurn.find((e) => e.t === 'run')
      if (run) run.conversation = 'filmmock1'
      compareTurn.push({ t: 'done', share: '/s/filmmock1' })
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: ndjson(compareTurn),
      })
      return
    }

    if (method === 'POST' && path === '/api/buy') {
      let body = {}
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {}

      if (!body.card || !body.conversation) {
        await route.fulfill({
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
          body: JSON.stringify({ error: 'Send a conversation and a card.' }),
        })
        return
      }

      const cardId = body.card
      boughtCard = cardId

      if (!body.method) {
        const run = { t: 'run', conversation: 'filmmock1', turn: 2, mode: 'live', said: 'Buy this one: Paperback copy of The Difference Engine', purpose: 'buy' }
        const call = { t: 'call', n: 17, tool: 'buy_gift', args: { card_id: cardId, amount_usd: 15 } }
        const result = { t: 'result', n: 17, tool: 'buy_gift', ok: true, ms: 1200, cached: false, text: 'PayPal sandbox order 1RP84723JX9338815 for $15.00, waiting for the buyer to approve.', top: [] }
        const order = { t: 'order', card: cardId, gift: 'Paperback copy of The Difference Engine', order_id: '1RP84723JX9338815', amount: '15.00', method: 'paypal', approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=1RP84723JX9338815' }
        const usage = { t: 'usage', model_calls: 1, neurons: 5.9 }
        const done = { t: 'done', share: '/s/filmmock1' }
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
          body: ndjson([run, call, result, order, usage, done]),
        })
        return
      }

      const buyTurn = structuredClone(zai[2]).filter((e) => e.t !== 'refunded')
      for (const event of buyTurn) {
        if (event.t === 'run') event.conversation = 'filmmock1'
        if ('card' in event) event.card = cardId
        if (event.args && 'card_id' in event.args) event.args.card_id = cardId
        if (event.t === 'order' && body.method) event.method = body.method
      }
      buyTurn.push({ t: 'done', share: '/s/filmmock1' })

      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: ndjson(buyTurn),
      })
      return
    }

    if (method === 'POST' && path === '/api/refund') {
      let body = {}
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {}
      const cardId = body.card || boughtCard
      const refunded = structuredClone(zai[2].find((e) => e.t === 'refunded'))
      if (refunded) refunded.card = cardId
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify({ event: refunded }),
      })
      return
    }

    if (method === 'GET' && path === '/api/conversation/filmmock1') {
      const saved0 = structuredClone(zy[0])
      const srun0 = saved0.find((e) => e.t === 'run')
      if (srun0) srun0.conversation = 'filmmock1'

      const saved1 = structuredClone(zy[1])
      const srun1 = saved1.find((e) => e.t === 'run')
      if (srun1) srun1.conversation = 'filmmock1'

      const saved2 = structuredClone(zy[2])
      const srun2 = saved2.find((e) => e.t === 'run')
      if (srun2) srun2.conversation = 'filmmock1'

      const srun3 = structuredClone(zy[3].find((e) => e.t === 'run'))
      if (srun3) srun3.conversation = 'filmmock1'
      const swithdrawn3 = structuredClone(zy[3].find((e) => e.t === 'cards_withdrawn'))
      const ssay3 = structuredClone(zy[3].find((e) => e.t === 'say'))
      const scardsEvent = structuredClone(zai[1].find((e) => e.t === 'cards'))
      if (scardsEvent?.cards) {
        scardsEvent.cards.forEach((card, index) => {
          card.id = `t3c${index + 1}`
        })
      }
      const susage3 = structuredClone(zy[3].find((e) => e.t === 'usage'))
      const saved3 = [srun3, swithdrawn3, ssay3, scardsEvent, susage3].filter(Boolean)

      const saved4 = structuredClone(zai[2])
      for (const event of saved4) {
        if (event.t === 'run') event.conversation = 'filmmock1'
        if ('card' in event) event.card = boughtCard
        if (event.args && 'card_id' in event.args) event.args.card_id = boughtCard
      }

      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify({ turns: [saved0, saved1, saved2, saved3, saved4] }),
      })
      return
    }

    if (method === 'GET' && path === '/s/filmmock1') {
      let html = ''
      try {
        html = readFileSync(resolve('public/index.html'), 'utf8')
      } catch {
        html = '<!doctype html><html><body><h1>Gift Scout</h1></body></html>'
      }
      const title = 'Gift Scout: My dad. Le Carre novels and single malt. Christmas, under 70 dollars.'
      const description = 'Ideas: Paperback copy of The Difference Engine, 750ml bottle of Talisker single malt, Guided walking tour of Edinburgh'
      html = html.replace(
        '<title>Gift Scout</title>',
        `<title>${title}</title><meta name="description" content="${description}">`,
      )
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: html,
      })
      return
    }

    await route.continue()
  })
}
