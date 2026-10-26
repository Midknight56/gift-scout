// The play through: a real visitor from the empty page to a paid gift, and the bad paths beside it. Headless (no window
// on any screen), one browser, and it will not start while another Playwright run is alive on this PC.
//
//   node tools/e2e.mjs [base url] [--pay=testcard|buyer] [--video]
//
// testcard (the default): Gift Scout pays the sandbox order on the server with PayPal's published test card; no login.
// buyer: approve at PayPal as the sandbox buyer.
//
// Happy path: example 2, six cards with Qloo's split in the cards, panel and share page, the panel's Qloo calls,
// "Compare with Qloo off", Qloo's scores for the plain model's picks, "Make it cheaper, under 30 dollars.", "Buy this one", PayPal sandbox approval as the sandbox buyer, back to the share page with
// the capture row. Bad paths: a two letter message, a share link that never existed, a /paid link Gift Scout never made,
// a stranger seeing no buy button or compare button, a compare without the owner token, a second compare, a buy without the owner token, and a buy with a wrong owner token.
// The sandbox buyer's login is read from the secrets file at run time and never printed.
// Run it through the shared browser lock: python A:/Projects/shipatonv2/tools/pw_lock.py run gift-scout -- node tools/e2e.mjs ...
import { execSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const BASE = (args.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const PAY = (args.find((a) => a.startsWith('--pay=')) ?? '--pay=testcard').slice(6)
if (!['testcard', 'buyer'].includes(PAY)) {
  console.error(`Unknown --pay value: ${PAY}. Use --pay=testcard or --pay=buyer.`)
  process.exit(2)
}
const VIDEO = args.includes('--video')
const SECRETS = 'C:/Users/User/.cloudflare/paypal-sandbox.local.txt'

function otherPlaywrightRuns() {
  const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' })
  return out.split('\n').filter((l) => /chrome-headless-shell|playwright/i.test(l)).length
}

function sandboxBuyer() {
  const text = readFileSync(SECRETS, 'utf8')
  const get = (k) => (text.match(new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)`, 'm')) ?? [])[1]
  return { email: get('PAYPAL_SANDBOX_BUYER_EMAIL'), password: get('PAYPAL_SANDBOX_BUYER_PASSWORD') }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`)
}

async function payAtPayPal(page) {
  await page.waitForURL(/sandbox\.paypal\.com/, { timeout: 60000 })
  check('the tap goes to the PayPal sandbox', true, new URL(page.url()).host)
  const { email, password } = sandboxBuyer()
  const emailBox = page.locator('#email')
  if (await emailBox.isVisible({ timeout: 15000 }).catch(() => false)) {
    await emailBox.fill(email)
    await page.locator('#btnNext').click()
    await page.locator('#password').fill(password)
    await page.locator('#btnLogin').click()
  }
  await page.getByRole('button', { name: /complete purchase|pay now|continue/i }).first().click({ timeout: 60000 })
}

async function main() {
  const busy = otherPlaywrightRuns()
  if (busy) { console.log(`HELD: ${busy} headless browser processes of another run are alive; try again when they end.`); process.exit(3) }
  mkdirSync('out', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(VIDEO ? { recordVideo: { dir: 'out/e2e-video', size: { width: 1280, height: 800 } } } : {}) })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    // Bad paths first: they cost nothing.
    await page.goto(BASE + '/')
    await page.locator('#message').fill('hi')
    await page.locator('.send-button').click()
    await page.locator('.error-line').first().waitFor({ timeout: 15000 })
    check('a two letter message gets a calm line', /tell me a little/i.test(await page.locator('.error-line').first().innerText()))
    await page.goto(BASE + '/s/nosuchconversation')
    await page.locator('.error-line').first().waitFor({ timeout: 15000 })
    check('a share link that never existed says so', /expired or never existed/i.test(await page.locator('.error-line').first().innerText()))
    const bogus = await page.goto(BASE + '/paid?c=nosuchconversation&token=ABCDEFGHIJ123456')
    check('a /paid link Gift Scout never made is refused', bogus?.status() === 404, `HTTP ${bogus?.status()}`)

    // The happy path.
    await page.goto(BASE + '/')
    await page.locator('[data-example]').nth(1).click()
    await page.locator('.gift-card').nth(4).waitFor({ timeout: 120000 })
    await page.waitForTimeout(1500)
    // A streamed answer keeps no body in the browser, so the conversation id comes from the owner token's key and the
    // run's mode from the saved conversation (saved when the turn ends).
    const conversationId = await page.evaluate(() => Object.keys(sessionStorage).find((k) => k.startsWith('gift-scout-owner:'))?.slice('gift-scout-owner:'.length))
    let runMode
    for (let i = 0; i < 30 && !runMode; i++) {
      runMode = await page.evaluate(async (id) => { const r = await fetch('/api/conversation/' + id); return r.ok ? (await r.json()).turns?.[0]?.[0]?.mode : undefined }, conversationId)
      if (!runMode) await page.waitForTimeout(1000)
    }
    console.log(`Run mode: ${runMode}`)
    const cards = await page.locator('.gift-card').count()
    const calls = await page.locator('.call-row').count()
    const mode = await page.locator('#run-label').innerText()
    check('example 2 gives five or six cards', cards >= 5 && cards <= 6, `${cards} cards`)
    check('the panel shows the Qloo calls', calls >= 5, `${calls} calls, mode "${mode}"`)
    check('every card links to its call', (await page.locator('.gift-card .call-link').count()) === cards)

    const cardSplitTexts = await page.locator('.gift-card .because-seeds').allInnerTexts()
    const splitCards = cardSplitTexts.map((text, index) => {
      const percentages = [...text.matchAll(/(\d+)%/g)].map((match) => Number(match[1]))
      return { index, text, percentages }
    }).filter((card) => card.percentages.length > 0)
    if (runMode === 'live' || runMode === 'cache') {
      check("cards show Qloo's split", splitCards.length >= 4, `${splitCards.length} cards`)
      check('each split adds up to 100', splitCards.length >= 4 && splitCards.every((card) => card.percentages.reduce((sum, value) => sum + value, 0) === 100))
      const panelSplits = await page.locator('.result-shares').count()
      check('the panel shows the split', panelSplits > 0, `${panelSplits} split rows`)
    } else if (runMode === 'replay') {
      console.log('SKIP the split checks: a recorded run from before the split')
    }

    const compareButton = page.locator('[data-compare]')
    const hasCompareButton = await compareButton.count() > 0
    check('the owner can compare with Qloo off', hasCompareButton)
    let comparisonSkipped = false
    let comparisonBlock = false
    const comparisonAttempted = hasCompareButton
    if (hasCompareButton) {
      await compareButton.click()
      await page.waitForFunction(() => document.querySelector('.compare-block') || document.querySelector('.error-line'), null, { timeout: 120000 })
      comparisonBlock = await page.locator('.compare-block').count() > 0
      const comparisonError = comparisonBlock ? '' : await page.locator('.error-line').last().innerText().catch(() => '')
      if (/live scouting, which is off/i.test(comparisonError)) {
        comparisonSkipped = true
        console.log('SKIP the comparison: live scouting is off')
      } else if (runMode === 'live' || runMode === 'cache') {
        const comparisonItems = await page.locator('.compare-block .compare-item').count()
        const comparisonSummary = await page.locator('.compare-block .compare-summary').innerText().catch(() => '')
        check("the comparison shows Qloo's scores", comparisonBlock && comparisonItems >= 1 && comparisonItems <= 6 && /mean affinity/i.test(comparisonSummary), `${comparisonItems} rows; ${comparisonSummary}`)
      }
    }
    if (comparisonAttempted && !comparisonSkipped) {
      const secondCompareRefused = await page.evaluate(async (conversation) => {
        const owner = sessionStorage.getItem(`gift-scout-owner:${conversation}`)
        const response = await fetch('/api/compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation, owner }),
        })
        const lines = (await response.text()).split('\n').filter(Boolean)
        return lines.some((line) => {
          try {
            const event = JSON.parse(line)
            return event.t === 'error' && event.text === 'This conversation was already compared.'
          } catch { return false }
        })
      }, conversationId)
      check('a second compare is refused', secondCompareRefused)
    }

    const cardId = await page.locator('.gift-card [data-buy]').first().getAttribute('data-buy')
    const strangerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      const strangerPage = await strangerContext.newPage()
      await strangerPage.goto(`${BASE}/s/${conversationId}`)
      await strangerPage.locator('.gift-card').first().waitFor({ timeout: 15000 })
      await strangerPage.locator('.start-own').waitFor({ timeout: 15000 })
      const sharedCards = await strangerPage.locator('.gift-card').count()
      const visibleBuyButtons = await strangerPage.getByRole('button', { name: 'Buy this one', exact: true }).count()
      check('stranger sees no buy button', sharedCards > 0 && visibleBuyButtons === 0, `${sharedCards} cards, ${visibleBuyButtons} buy buttons`)
      const visibleCompareButtons = await strangerPage.getByRole('button', { name: 'Compare with Qloo off', exact: true }).count()
      check('stranger sees no compare button', visibleCompareButtons === 0, `${visibleCompareButtons} compare buttons`)
      if (comparisonAttempted && !comparisonSkipped) {
        const sharedComparison = await strangerPage.locator('.compare-block').innerText().catch(() => '')
        const ownerComparison = await page.locator('.compare-block').innerText().catch(() => '')
        check('the share page keeps the comparison', Boolean(sharedComparison) && sharedComparison === ownerComparison)
      }
      if (runMode === 'live' || runMode === 'cache') {
        const sharedSplitTexts = await strangerPage.locator('.gift-card .because-seeds').allInnerTexts()
        check('the share page keeps the split', splitCards.length >= 4 && splitCards.every((card) => sharedSplitTexts[card.index] === card.text))
      }

      const noOwnerStatus = await strangerPage.evaluate(async ({ conversation, card }) => {
        const response = await fetch('/api/buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation, card, method: 'card' }),
        })
        return response.status
      }, { conversation: conversationId, card: cardId })
      check('buy without the owner token is refused', noOwnerStatus === 403, `HTTP ${noOwnerStatus}`)

      const noOwnerCompareStatus = await strangerPage.evaluate(async (conversation) => {
        const response = await fetch('/api/compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation }),
        })
        return response.status
      }, conversationId)
      check('compare without the owner token is refused', noOwnerCompareStatus === 403, `HTTP ${noOwnerCompareStatus}`)

      const wrongOwnerStatus = await strangerPage.evaluate(async ({ conversation, card }) => {
        const response = await fetch('/api/buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation, card, method: 'card', owner: 'a'.repeat(64) }),
        })
        return response.status
      }, { conversation: conversationId, card: cardId })
      check('buy with a wrong owner token is refused', wrongOwnerStatus === 403, `HTTP ${wrongOwnerStatus}`)
    } finally {
      await strangerContext.close()
    }

    await page.locator('.narrow-chip').click()
    await page.locator('.card-list').nth(1).locator('.gift-card').first().waitFor({ timeout: 120000 })
    await page.waitForTimeout(1500)
    const prices = await page.locator('.card-list').nth(1).locator('.price').allInnerTexts()
    const highs = prices.map((p) => Number((p.match(/\$(\d+)\s*$/) ?? [])[1]))
    check('the narrowing turn keeps every card at 30 dollars or less', highs.length > 0 && highs.every((h) => h <= 30), prices.join(', '))

    await page.locator('[data-buy]').first().click()
    if (PAY === 'testcard') {
      await page.locator('[data-pay="card"]').first().click()
      await page.locator('.pay-row.paid').waitFor({ timeout: 120000 })
    } else {
      await page.locator('[data-pay="paypal"]').first().click()
      await payAtPayPal(page)
      await page.waitForURL(new RegExp('^' + BASE.replace(/[.]/g, '\\.') + '/s/'), { timeout: 120000 })
      await page.locator('.pay-row.paid').waitFor({ timeout: 30000 })
    }
    const paid = await page.locator('.pay-row.paid').innerText()
    check('back at Gift Scout, the panel shows the capture', /capture [A-Z0-9]{10,}/.test(paid), paid.replace(/\s+/g, ' ').slice(0, 120))
    check('no script error on any page', errors.length === 0, errors.join(' | '))
  } catch (e) {
    check('the run reached its end', false, String(e).split('\n')[0])
    await page.screenshot({ path: 'out/e2e-failure.png', fullPage: true }).catch(() => {})
  } finally {
    await context.close()
    await browser.close()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `${failed} FAILED` : 'ALL PASS')
  process.exit(failed ? 1 : 0)
}

main()
