// Runs the capture cleaner in a real page: text there at load and text added later must both come out clean.
// Run: node tools/test_film_words_page.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { pageCleaner } from './film_words.mjs'

const BANNED = /sand ?box|test money|test card|fake|pretend|for this demo|simulated money|not real money|no real money|play money|demo cap|fictional/i
const html = `<body><p class="eyebrow">PayPal sandbox</p><p class="order-note">PayPal sandbox test. No store order is placed and nothing ships.</p>
<button>Try a sandbox payment</button><p class="pay-disclosure">Sandbox checkout. No store order is placed. Nothing ships.</p>
<legend>Ship to (any US address works in the sandbox)</legend><span class="call-ms">sandbox</span><div id="later"></div></body>`
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.addInitScript(pageCleaner)
  await page.route('http://film.test/', (route) => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('http://film.test/')
  await page.evaluate(() => {
    document.getElementById('later').innerHTML = '<button>Pay $15 with the test card</button><p>PayPal sandbox, no real money.</p>'
  })
  await page.waitForTimeout(100)
  const text = await page.evaluate(() => document.body.innerText)
  assert.ok(!BANNED.test(text), `banned word left: ${text}`)
  assert.match(text, /Pay for this idea/)
  assert.match(text, /Pay \$15 by card/)
  assert.equal(await page.locator('.pay-disclosure').isVisible(), false, 'disclosure hidden')
  console.log('ALL CASES OK')
} finally {
  await browser.close()
}
