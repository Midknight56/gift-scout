// Record a complete Gift Scout visit as a continuous screencast and timestamped caption beats.
// Usage: node tools/film_tour.mjs [base url] [--no-hold] [--skip-compare]
// Order: brief, shortlist, comparison, refine, leave one interest out, a store listing, payment, tracker,
// refund, share link. The long panel scroll and the How it works dialog are left out so the film stays on the product.
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { installMock } from './film_mock.mjs'
import { pageCleaner } from './film_words.mjs'

const args = process.argv.slice(2)
const BASE = (args.find((arg) => arg.startsWith('http')) ?? 'https://gift-scout.midknight-labs.workers.dev').replace(/\/$/, '')
const isMock = args.includes('--mock')
const OUT = isMock ? 'out/film-mock' : 'out/film'
const FRAMES = resolve(OUT, 'tour-frames')
const MESSAGE = 'My dad. Le Carre novels and single malt. Christmas, under 70 dollars.'

if (!args.includes('--no-hold') && execSync('tasklist /FO CSV /NH', { encoding: 'utf8' }).split('\n').some((line) => /chrome-headless-shell|playwright/i.test(line))) {
  console.log('HELD: another Playwright run is alive')
  process.exit(3)
}

mkdirSync(OUT, { recursive: true })
rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1.2', '--window-size=1600,900'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
const frames = []
const beats = []
let filming = false
let start = 0
let stoppedAt = 0

cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
  if (!filming) return
  const file = join(FRAMES, `${String(frames.length).padStart(6, '0')}.jpg`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  frames.push({ file, time: Date.now() / 1000 })
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})

const pause = (ms) => page.waitForTimeout(ms)
const waitForDuration = async (ms) => page.waitForFunction((until) => Date.now() >= until, Date.now() + ms, { timeout: ms + 5000 })
const clean = (value) => value.replace(/\s+/g, ' ').trim().slice(0, 400)
const visibleText = async (selector) => clean(await page.locator(selector).first().innerText({ timeout: 2000 }).catch(() => ''))
const beat = async (name, selector, click = false, textOverride) => {
  const text = textOverride ?? (selector ? await visibleText(selector) : '')
  beats.push({ name, at: Math.round((Date.now() / 1000 - start) * 100) / 100, ...(click ? { click: true } : { click: false }), text })
  console.log(`${beats.at(-1).at}s ${name}`)
}
const click = async (locator) => {
  await locator.scrollIntoViewIfNeeded()
  const deadline = Date.now() + 3000
  let previous = await locator.boundingBox()
  if (!previous) throw new Error('Cannot click an element that is not visible')
  let box = null
  while (Date.now() < deadline) {
    await pause(100)
    const current = await locator.boundingBox()
    if (!current) throw new Error('Cannot click an element that is not visible')
    if (Math.abs(current.x - previous.x) <= 1 && Math.abs(current.y - previous.y) <= 1 &&
        Math.abs(current.width - previous.width) <= 1 && Math.abs(current.height - previous.height) <= 1) {
      box = current
      break
    }
    previous = current
  }
  if (!box) throw new Error('Element did not stop moving within 3 seconds')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y, { steps: 25 })
  await pause(350)
  await page.mouse.click(x, y)
}
const smoothIntoView = async (locator) => {
  await locator.evaluate((element) => element.scrollIntoView({ behavior: 'smooth', block: 'center' }))
}
const animateScroll = async (locator, duration) => {
  await locator.evaluate((element, duration) => {
    const start = element.scrollTop
    const distance = element.scrollHeight - element.clientHeight - start
    const began = performance.now()
    element.dataset.filmScrollDone = 'false'
    const step = (now) => {
      const progress = Math.min((now - began) / duration, 1)
      element.scrollTop = start + distance * progress
      if (progress < 1) requestAnimationFrame(step)
      else element.dataset.filmScrollDone = 'true'
    }
    requestAnimationFrame(step)
  }, duration)
  const selector = await locator.evaluate((element) => `#${element.id}`)
  await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.filmScrollDone === 'true', selector, { timeout: duration + 5000 })
}
const waitAny = async (selectors, timeout) => {
  await page.waitForFunction((items) => items.some((selector) => document.querySelector(selector)), selectors, { timeout })
}
const cardsText = async (list, includeReason = false) => list.locator('.gift-card').evaluateAll((cards, includeReason) => cards.map((card) => {
  const title = card.querySelector('.gift-name')?.innerText ?? ''
  const reason = card.querySelector('.because-seeds')?.innerText ?? ''
  const price = card.querySelector('.price')?.innerText ?? ''
  return [title, includeReason ? reason : price].filter(Boolean).join(' ')
}).join(' | '), includeReason).then(clean)

try {
  await page.addInitScript(pageCleaner)
  await page.addInitScript(() => {
    window.__filmShareUrl = null
    try {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: (value) => { window.__filmShareUrl = value; return Promise.resolve() } })
    } catch {}
  })
  if (isMock) await installMock(page)
  await page.goto(BASE + '/')
  await page.locator('[data-example]').first().waitFor()
  const appHeight = await page.locator('.app-shell').evaluate((element) => element.getBoundingClientRect().height)
  const viewportHeight = await page.evaluate(() => window.innerHeight)
  if (Math.abs(appHeight - viewportHeight) > 2) {
    console.error(`APP HEIGHT ${appHeight} of ${viewportHeight}`)
    process.exitCode = 1
    throw new Error('Application shell height does not match the viewport')
  }
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
  filming = true
  start = Date.now() / 1000
  await page.addStyleTag({ content: '#film-tour-pointer{position:fixed;left:0;top:0;width:16px;height:16px;border-radius:50%;background:#18202b;border:2px solid white;box-shadow:0 0 0 1px #18202b;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%)}' })
  await page.evaluate(() => {
    const dot = document.createElement('div')
    dot.id = 'film-tour-pointer'
    document.body.append(dot)
    document.addEventListener('mousemove', (event) => { dot.style.left = `${event.clientX}px`; dot.style.top = `${event.clientY}px` })
  })
  await beat('empty', null, false, clean(`${await page.locator('h1').first().innerText()} ${await page.locator('#message').getAttribute('placeholder') ?? ''}`))
  await pause(3500)

  const message = page.locator('#message')
  await click(message)
  await page.keyboard.type(MESSAGE, { delay: 55 })
  await pause(800)
  await beat('sent', '#message', true)
  await page.keyboard.press('Enter')

  await page.locator('.call-row').first().waitFor({ timeout: 120000 })
  await beat('first call', '.call-row')
  await page.locator('.gift-card').first().waitFor({ timeout: 120000 })
  await beat('first card', '.gift-card')
  await page.waitForFunction(() => {
    const count = document.querySelectorAll('.gift-card').length
    if (count < 3) { window.__filmInitialCards = null; return false }
    if (window.__filmInitialCards?.count !== count) { window.__filmInitialCards = { count, since: Date.now() }; return false }
    return Date.now() - window.__filmInitialCards.since >= 5000
  }, null, { timeout: 120000 })
  await pause(2000)
  await beat('cards in', '.gift-card', false, await cardsText(page.locator('.card-list').first(), true))
  await pause(4000)

  await page.locator('#chat-scroll').evaluate((element) => element.scrollTo({ top: element.scrollHeight / 3, behavior: 'smooth' }))
  await pause(2500)
  const callLink = page.locator('.gift-card .call-link').nth(1)
  await click(callLink)
  const panel = page.locator('#scene-panel')
  await panel.waitFor({ state: 'visible', timeout: 15000 })
  const panelHeader = await page.locator('#run-label, .panel-summary').allInnerTexts().then((lines) => lines.join(' ')).catch(() => '')
  const panelCall = await page.locator('#calls-list .call-row').first().innerText().catch(() => '')
  await beat('panel', null, true, clean(`${panelHeader} ${panelCall}`))
  const callsList = page.locator('#calls-list')
  await pause(5000)
  const graph = page.locator('.walk-panel svg').first()
  await graph.waitFor({ state: 'visible', timeout: 15000 })
  await graph.evaluate((element) => element.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  await pause(5000)
  await beat('graph', null, false, clean(`${await graph.getAttribute('aria-label') ?? ''} ${(await graph.locator('text').allInnerTexts()).join(' ')}`))

  if (!args.includes('--skip-compare')) {
    const compare = page.locator('[data-compare]').first()
    await smoothIntoView(compare)
    await click(compare)
    await beat('compare sent', '[data-compare]', true)
    await waitAny(['.compare-block', '.error-line'], 120000)
    const comparison = page.locator('.compare-block').first()
    if (await comparison.count()) await smoothIntoView(comparison)
    else await smoothIntoView(page.locator('.error-line').last())
    await beat('compare in', await comparison.count() ? '.compare-block' : '.error-line')
    await pause(7000)
  }

  const chip = page.locator('.narrow-chip').first()
  await smoothIntoView(chip)
  await click(chip)
  await beat('narrowing sent', '.narrow-chip', true)
  await page.locator('.card-list').nth(1).locator('.gift-card').first().waitFor({ timeout: 120000 })
  await page.waitForFunction(() => {
    const list = document.querySelectorAll('.card-list')[1]
    const count = list?.querySelectorAll('.gift-card').length ?? 0
    if (!count) { window.__filmNarrowedCards = null; return false }
    if (window.__filmNarrowedCards?.count !== count) { window.__filmNarrowedCards = { count, since: Date.now() }; return false }
    return Date.now() - window.__filmNarrowedCards.since >= 5000
  }, null, { timeout: 120000 })
  const secondList = page.locator('.card-list').nth(1)
  await smoothIntoView(secondList)
  await beat('narrowed in', null, false, await cardsText(secondList))
  await pause(6000)

  // Leave one interest out from its button in the panel, then show what was withdrawn and what replaced it.
  const malt = page.locator('[data-leave-out]').filter({ hasText: /single malt/i }).first()
  const leave = (await malt.count()) ? malt : page.locator('[data-leave-out]').last()
  await smoothIntoView(leave)
  await pause(1500)
  await beat('leave out shown', null, false, clean((await page.locator('[data-leave-out]').allInnerTexts()).join(' | ')))
  await click(leave)
  await beat('leave out sent', null, true, clean(await leave.innerText()))
  await page.locator('.leave-out-result').first().waitFor({ timeout: 120000 })
  await smoothIntoView(page.locator('.leave-out-result').first())
  await beat('left out', '.leave-out-result')
  await page.waitForFunction(() => /Find a gift/.test(document.querySelector('.send-button')?.textContent ?? ''), null, { timeout: 120000 })
  await pause(2000)
  const latest = page.locator('.card-list').last()
  await smoothIntoView(latest)
  await beat('replaced', null, false, await cardsText(latest))
  await pause(5000)
  await beat('graph after', null, false, clean(`${await page.locator('.walk-panel svg').first().getAttribute('aria-label').catch(() => '') ?? ''} ${(await page.locator('.walk-panel svg text').allInnerTexts().catch(() => [])).join(' ')}`))
  await pause(4000)

  // A store listing if the current cards have one, else an idea, labelled as such on the card.
  const current = page.locator('.card-list').last()
  const buyable = current.locator('.gift-card:not(.withdrawn)').filter({ has: page.locator('[data-buy]') })
  if (!(await buyable.count())) throw new Error('no card to buy')
  const offerCard = buyable.filter({ has: page.locator('.card-kind.offer') }).first()
  const chosen = (await offerCard.count()) ? offerCard : buyable.first()
  await smoothIntoView(chosen)
  await pause(1500)
  await beat(await offerCard.count() ? 'offer' : 'idea only', null, false, clean(await chosen.innerText()))
  await pause(6000)
  const buy = chosen.locator('[data-buy]').first()
  await click(buy)
  await beat('buy', '[data-buy]', true)
  const shipForm = page.locator('.ship-form')
  await smoothIntoView(shipForm)
  await pause(4000)
  await beat('ship form', null, false, await shipForm.evaluate((form) => `${form.innerText} ${[...form.querySelectorAll('input,select,textarea')].map((input) => input.value).join(' ')}`.replace(/\s+/g, ' ').trim().slice(0, 400)))
  await click(page.locator('[data-pay="card"]').first())
  await beat('pay', '[data-pay="card"]', true)
  await page.waitForFunction(() => document.querySelector('.pay-row.paid') || document.body.innerText.includes('This offer changed'), null, { timeout: 120000 })
  if (!(await page.locator('.pay-row.paid').count())) {
    await beat('offer changed', null, false, await page.getByText('This offer changed', { exact: false }).first().innerText())
    await pause(3000)
    await click(page.locator('[data-pay="card"]').first())
    await beat('pay again', '[data-pay="card"]', true)
  }
  await page.locator('.pay-row.paid').waitFor({ timeout: 120000 })
  await beat('paid', '.pay-row.paid')
  await page.locator('.pay-row.shipped').waitFor({ timeout: 30000 })
  await beat('tracker', '.pay-row.shipped')
  const order = page.locator('.order-block').first()
  await smoothIntoView(order)
  await pause(6000)
  await beat('order', '.order-block')

  const refund = page.locator('[data-refund]').first()
  await smoothIntoView(refund)
  await click(refund)
  await beat('refund', '[data-refund]', true)
  await page.locator('.pay-row.refunded').waitFor({ timeout: 60000 })
  await smoothIntoView(page.locator('.pay-row.refunded'))
  await beat('refunded', null, false, clean(`${await visibleText('.pay-row.refunded')} ${await page.locator('.order-block .order-title').innerText().catch(() => '')}`))
  await pause(5000)
  await animateScroll(callsList, 2000)
  await waitForDuration(6000)
  const paypalRows = await callsList.locator('.order-row, .pay-row').evaluateAll((rows) => rows.filter((row) => {
    const rowBox = row.getBoundingClientRect()
    const listBox = document.querySelector('#calls-list').getBoundingClientRect()
    return rowBox.bottom > listBox.top && rowBox.top < listBox.bottom
  }).map((row) => row.innerText).join(' | '))
  await beat('paypal rows', null, false, clean(paypalRows))

  const shareButton = page.locator('#usage .share-button').first()
  await shareButton.waitFor({ state: 'visible', timeout: 10000 })
  await click(shareButton)
  const shareUrl = await page.evaluate(() => window.__filmShareUrl)
  if (!shareUrl || !shareUrl.startsWith(BASE + '/s/')) throw new Error('The app did not expose its conversation share URL')
  await page.goto(shareUrl)
  await page.locator('.gift-card').first().waitFor({ state: 'attached', timeout: 30000 })
  await beat('share', null, false, clean(await page.locator('#chat-log').innerText()))
  const shareScroll = page.locator('#chat-scroll')
  await animateScroll(shareScroll, 10000)
  await beat('share scrolled', null, false, clean(await page.locator('#chat-log').innerText()))
  await waitForDuration(4000)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
  await pause(4000)
  await beat('end', null, false, clean(await page.locator('body').innerText()))
} catch (error) {
  const message = String(error?.message ?? error).split('\n')[0]
  beats.push({ name: 'failed', text: message })
  console.error(`FAILED: ${message}`)
} finally {
  if (filming) await cdp.send('Page.stopScreencast').catch(() => {})
  stoppedAt = Date.now() / 1000
  filming = false
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}

const end = stoppedAt || Date.now() / 1000
if (!frames.length) {
  console.error('FAILED: screencast produced no frames')
  beats.push({ name: 'failed', text: 'Screencast produced no frames' })
  writeFileSync(join(OUT, 'tour-beats.json'), JSON.stringify(beats, null, 2) + '\n')
  process.exit(1)
}
const list = frames.map((frame, index) => {
  const from = index === 0 ? Math.min(start, frame.time) : frame.time
  const next = index + 1 < frames.length ? frames[index + 1].time : Math.max(end, frame.time + 1 / 60)
  return `file '${frame.file.replace(/\\/g, '/')}'\nduration ${Math.max(next - from, 1 / 60).toFixed(4)}`
})
list.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`)
writeFileSync(join(FRAMES, 'list.txt'), list.join('\n') + '\n')
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(FRAMES, 'list.txt'),
  '-vf', 'fps=60,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', join(OUT, 'tour.mp4')])
writeFileSync(join(OUT, 'tour-beats.json'), JSON.stringify(beats, null, 2) + '\n')
rmSync(FRAMES, { recursive: true, force: true })
console.log(`filmed ${frames.length} frames into ${OUT}/tour.mp4`)
if (beats.some((item) => item.name === 'failed')) process.exit(1)
