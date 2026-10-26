// The phone sweep: the page at every width a phone shows it, measured, with a picture of each. Headless (no window),
// one browser, and it will not start while another Playwright run is alive on this PC.
//
//   node tools/phones.mjs [base url] [--share <conversation id>]
//
// Widths are CSS pixels in portrait. They span the PC's phone table (Duskroot tools/phones.json): its rows are screen
// pixels for a landscape game, so each width here is an estimate from the short side and a usual pixel ratio, not a
// measured browser width: 320 (small Android), 344 (a fold's cover), 360 (Galaxy A05, S21), 375 (iPhone SE), 390
// (iPhone 14), 393 (iPhone 16), 402 (iPhone 17), 412 (S24+, Pixel), 420 (iPhone Air), 440 (16 Pro Max), 466 (iPhone
// Duo closed), 669 (Duo open), 707 (Fold6 open), 820 (iPad). Desktop viewports follow: 1280x720, 1500x1000, 1920x1080.
// At each width, the empty page and a run with cards (an example, so no model call, or a saved share). The pay choice
// is checked on an example run only. Checks: no sideways scroll; every visible button 16 px or more inside the screen,
// 44 px or taller, its text inside it; no two buttons overlap; the walk, comparison, product, and seed-split blocks
// stay 16 px inside the right edge without sideways overflow; walk text is 11 px or taller; comparison and product
// links and buttons are 44 px or taller; then keyboard and screen reader basics once.
// Run it through the shared browser lock: python A:/Projects/shipatonv2/tools/pw_lock.py run gift-scout -- node tools/phones.mjs ...
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const shareIndex = args.indexOf('--share')
const shareId = shareIndex === -1 ? null : args[shareIndex + 1]
if (shareIndex !== -1 && !shareId) throw new Error('--share needs a conversation id')
const baseArg = args.find((arg) => arg.startsWith('http'))
const BASE = (baseArg ?? 'https://gift-scout.midknight-labs.workers.dev').replace(/\/$/, '')
const SHARE_URL = shareId ? BASE + '/s/' + encodeURIComponent(shareId) : null
const WIDTHS = [320, 344, 360, 375, 390, 393, 402, 412, 420, 440, 466, 669, 707, 820]
const DESKTOP_VIEWPORTS = [{ width: 1280, height: 720 }, { width: 1500, height: 1000 }, { width: 1920, height: 1080 }]
const failures = []

function busy() {
  return execSync('tasklist /FO CSV /NH', { encoding: 'utf8' }).split('\n').filter((l) => /chrome-headless-shell|playwright/i.test(l)).length
}

/** Measures every visible button and the page width; returns the faults found. */
async function measure(page) {
  return page.evaluate(() => {
    const faults = []
    const vw = document.documentElement.clientWidth
    if (document.documentElement.scrollWidth > vw + 1) faults.push(`sideways scroll: page ${document.documentElement.scrollWidth} px in ${vw} px`)
    const visible = [...document.querySelectorAll('button, .example-chip, input, textarea')].filter((el) => {
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      if (!(r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && el.closest('[hidden]') === null && !el.closest('.scene-panel:not(.open)'))) return false
      // Only what is truly on screen: a control scrolled out of its pane, or behind the bar at the bottom, is not.
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false
      const hit = document.elementFromPoint(x, y)
      return !!hit && (el === hit || el.contains(hit) || hit.contains(el))
    })
    const boxes = visible.map((el) => ({ el, r: el.getBoundingClientRect(), name: (el.innerText || el.getAttribute('aria-label') || el.placeholder || el.tagName).trim().slice(0, 30) }))
    for (const { el, r, name } of boxes) {
      if (r.left < 16 - 0.5 || vw - r.right < 16 - 0.5) faults.push(`"${name}" is ${Math.round(Math.min(r.left, vw - r.right))} px from the edge`)
      if (el.tagName === 'BUTTON' && r.height < 44 - 0.5) faults.push(`"${name}" is ${Math.round(r.height)} px tall`)
      if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 1) faults.push(`"${name}" text overflows its button`)
    }
    const blocks = [
      ['walk svg', [...document.querySelectorAll('.walk-panel svg')]],
      ['compare-block', [...document.querySelectorAll('.compare-block')]],
      ['product-block', [...document.querySelectorAll('.product-block')]],
      ['because-seeds', [...document.querySelectorAll('.because-seeds')]],
    ]
    for (const [name, elements] of blocks) {
      elements.forEach((el, index) => {
        const label = name + (elements.length > 1 ? ' ' + (index + 1) : '')
        const r = el.getBoundingClientRect()
        if (r.right > vw - 16) faults.push(label + ' at ' + vw + 'px has right edge ' + Math.round(r.right) + ' px, past ' + (vw - 16) + ' px')
        if (el.scrollWidth > el.clientWidth + 1) faults.push(label + ' at ' + vw + 'px overflows sideways (' + el.scrollWidth + ' px in ' + el.clientWidth + ' px)')
      })
    }
    for (const [index, el] of [...document.querySelectorAll('.walk-panel svg text')].entries()) {
      const height = el.getBoundingClientRect().height
      if (height < 11) faults.push('walk svg text ' + (index + 1) + ' at ' + vw + 'px is ' + height.toFixed(1) + ' px tall')
    }
    for (const el of document.querySelectorAll('.compare-block a, .compare-block button, .product-block a, .product-block button')) {
      const height = el.getBoundingClientRect().height
      const block = el.closest('.compare-block') ? 'compare-block' : 'product-block'
      const name = (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30)
      if (height < 44) faults.push(block + ' "' + name + '" at ' + vw + 'px is ' + Math.round(height) + ' px tall')
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r
        if (boxes[i].el.contains(boxes[j].el) || boxes[j].el.contains(boxes[i].el)) continue
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) faults.push(`"${boxes[i].name}" overlaps "${boxes[j].name}"`)
      }
    }
    return faults
  })
}

async function measureDesktopScroll(page, viewport) {
  return page.evaluate(({ width, height }) => {
    const faults = []
    const scrollBoxFor = (element) => {
      let node = element.parentElement
      while (node && node !== document.documentElement) {
        const overflowY = getComputedStyle(node).overflowY
        if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node
        node = node.parentElement
      }
      return null
    }
    const insideWindow = (element) => {
      const rect = element.getBoundingClientRect()
      return rect.top >= -1 && rect.bottom <= innerHeight + 1
    }
    const lastChatItem = document.querySelector('#chat-log')?.lastElementChild
    const chatBox = lastChatItem && scrollBoxFor(lastChatItem)
    if (!chatBox) {
      faults.push('chat scroll box was not found')
    } else {
      chatBox.scrollTop = chatBox.scrollHeight
      if (!insideWindow(lastChatItem)) faults.push('last chat item is outside the window after scrolling chat to the end')
    }

    const lastCall = document.querySelector('#calls-list .call-row:last-child')
    const panelBox = lastCall && scrollBoxFor(lastCall)
    if (!panelBox) {
      faults.push('Behind the scenes scroll box was not found')
    } else {
      panelBox.scrollTop = panelBox.scrollHeight
      if (!insideWindow(lastCall)) faults.push('last call row is outside the window after scrolling Behind the scenes to the end')
    }

    const shell = document.querySelector('.app-shell')
    if (shell.scrollHeight > shell.clientHeight + 1) faults.push(`app shell scrollHeight ${shell.scrollHeight} exceeds clientHeight ${shell.clientHeight}`)
    return faults.map((fault) => `${width}x${height} ${fault}`)
  }, viewport)
}

async function main() {
  const n = busy()
  if (n) { console.log(`HELD: ${n} headless browser processes of another run are alive`); process.exit(3) }
  mkdirSync('out/phones', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: width > 600 ? 1024 : 800 }, deviceScaleFactor: 2, isMobile: width < 600, hasTouch: width < 600 })
      const page = await context.newPage()
      await page.goto(BASE + '/')
      await page.locator('[data-example]').first().waitFor()
      const states = [['empty', null]]
      for (const [state] of states) {
        const f = await measure(page)
        await page.screenshot({ path: `out/phones/${width}-${state}.png` })
        for (const x of f) failures.push(`${width} ${state}: ${x}`)
      }
      if (SHARE_URL) {
        await page.goto(SHARE_URL)
        await page.locator('.gift-card').first().waitFor({ timeout: 120000 })
      } else {
        await page.locator('[data-example]').nth(1).click()
        await page.locator('.gift-card').nth(4).waitFor({ timeout: 120000 })
      }
      await page.waitForTimeout(1200)
      for (const x of await measure(page)) failures.push(`${width} cards: ${x}`)
      await page.screenshot({ path: `out/phones/${width}-cards.png`, fullPage: false })
      const panelNeeded = await page.locator('.walk-panel svg, .compare-block').count() > 0
      const openedPanel = panelNeeded && width < 761 && !(await page.locator('#scene-panel').evaluate((el) => el.classList.contains('open')))
      if (openedPanel) await page.locator('#panel-trigger').click()
      if (await page.locator('.walk-panel svg').count()) {
        await page.locator('#scene-panel').screenshot({ path: 'out/phones/' + width + '-walk.png' })
      }
      if (await page.locator('.compare-block').count()) {
        await page.locator('.compare-block').first().screenshot({ path: 'out/phones/' + width + '-compare.png' })
      }
      if (openedPanel) await page.locator('#panel-trigger').click()
      if (SHARE_URL) {
        console.log(width + ': SKIP pay choice (share page)')
      } else {
        const buy = page.locator('[data-buy]').first()
        await buy.scrollIntoViewIfNeeded()
        await buy.click()
        await page.waitForTimeout(400)
      for (const x of await measure(page)) failures.push(`${width} pay choice: ${x}`)
      await page.locator('.pay-choice').first().screenshot({ path: `out/phones/${width}-pay.png` })
      }
      console.log(`${width}: measured`)
      await context.close()
    }

    for (const viewport of DESKTOP_VIEWPORTS) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: false, hasTouch: false })
      const page = await context.newPage()
      await page.goto(BASE + '/')
      await page.locator('[data-example]').first().waitFor()
      for (const x of await measure(page)) failures.push(`${viewport.width}x${viewport.height} empty: ${x}`)
      await page.screenshot({ path: `out/phones/${viewport.width}x${viewport.height}-empty.png` })
      if (SHARE_URL) {
        await page.goto(SHARE_URL)
        await page.locator('.gift-card').first().waitFor({ timeout: 120000 })
      } else {
        await page.locator('[data-example]').nth(1).click()
        await page.locator('.gift-card').nth(4).waitFor({ timeout: 120000 })
      }
      await page.waitForTimeout(1200)
      for (const x of await measure(page)) failures.push(`${viewport.width}x${viewport.height} cards: ${x}`)
      for (const x of await measureDesktopScroll(page, viewport)) failures.push(x)
      await page.screenshot({ path: `out/phones/${viewport.width}x${viewport.height}-cards.png`, fullPage: false })
      if (SHARE_URL) {
        console.log(`${viewport.width}x${viewport.height}: SKIP pay choice (share page)`)
      } else {
        console.log(`${viewport.width}x${viewport.height}: SKIP pay choice (desktop)`)
      }
      console.log(`${viewport.width}x${viewport.height}: measured`)
      await context.close()
    }

    // Keyboard and screen reader basics, once, at 390.
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } })
    const page = await context.newPage()
    await page.goto(BASE + '/')
    await page.locator('[data-example]').first().waitFor()
    const basics = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      live: document.querySelector('#chat-log')?.getAttribute('aria-live'),
      unnamed: [...document.querySelectorAll('button')].filter((b) => !(b.innerText.trim() || b.getAttribute('aria-label'))).length,
      inputLabel: !!document.querySelector('label[for="message"]'),
    }))
    if (basics.lang !== 'en') failures.push(`basics: html lang is "${basics.lang}"`)
    if (basics.live !== 'polite') failures.push('basics: the chat log is not aria-live polite')
    if (basics.unnamed) failures.push(`basics: ${basics.unnamed} buttons have no name`)
    if (!basics.inputLabel) failures.push('basics: the message box has no label')
    const reached = []
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      reached.push(await page.evaluate(() => {
        const el = document.activeElement
        const st = getComputedStyle(el)
        return { tag: el.tagName, example: el.matches('[data-example]'), ring: st.outlineStyle !== 'none' || st.boxShadow !== 'none' }
      }))
    }
    if (!reached.some((r) => r.example)) failures.push('keyboard: Tab never reaches an example')
    if (!reached.some((r) => r.tag === 'TEXTAREA')) failures.push('keyboard: Tab never reaches the message box')
    const noRing = reached.filter((r) => !r.ring && r.tag !== 'BODY')
    if (noRing.length) failures.push(`keyboard: ${noRing.length} focused controls show no focus ring`)
    await page.locator('[data-example]').first().focus()
    await page.keyboard.press('Enter')
    await page.locator('.gift-card').first().waitFor({ timeout: 120000 }).catch(() => failures.push('keyboard: Enter on an example started nothing'))
    console.log(`keyboard: reached ${reached.map((r) => r.example ? 'example' : r.tag.toLowerCase()).join(', ')}`)
    await context.close()
  } finally {
    await browser.close()
  }
  for (const f of failures) console.log('FAIL ' + f)
  console.log(failures.length ? `${failures.length} FAULTS` : `ALL PASS at ${WIDTHS.length} phone widths and ${DESKTOP_VIEWPORTS.length} desktop sizes`)
  process.exit(failures.length ? 1 : 0)
}

main()
