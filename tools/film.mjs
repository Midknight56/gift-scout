// Films the product for the video: one continuous take of a real visitor, recorded sharp with Chrome's own screencast
// (every painted frame as a JPEG with its time, joined by ffmpeg into a 60 fps mp4), plus a beats file that says when
// each moment happens, for the editor. Headless (no window), one browser, waits for no one: it refuses to start while
// another Playwright run is alive on this PC.
//
//   node tools/film.mjs [base url] [--pay=paypal|testcard] [--until=narrowed|end]
//
// Writes out/film/take.mp4 (2880 x 1800, the page at 1440 x 900 drawn at 2x) and out/film/beats.json.
// The take: the empty page, the dad example typed, the Qloo calls and the cards arriving, the panel opened at a card's
// call, "Make it cheaper, under 30 dollars.", "Buy this one", then PayPal (the sandbox buyer approves) or the test card,
// and the capture row. Film it in live mode (after the daily neuron reset) so the Qloo calls take their real time.
// Run it through the shared browser lock: python A:/Projects/shipatonv2/tools/pw_lock.py run gift-scout -- node tools/film.mjs ...
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const BASE = (args.find((a) => a.startsWith('http')) ?? 'https://gift-scout.midknight-labs.workers.dev').replace(/\/$/, '')
const PAY = (args.find((a) => a.startsWith('--pay=')) ?? '--pay=paypal').slice(6)
// --until=narrowed stops after the narrowed cards: a take that needs no live model call (the purchase does).
const UNTIL = (args.find((a) => a.startsWith('--until=')) ?? '--until=end').slice(8)
const OUT = 'out/film'
// Absolute: ffmpeg reads the paths in its list relative to the list's own folder (23 Oct: "Impossible to open").
const FRAMES = resolve(OUT, 'frames')
const MESSAGE = 'My dad. Le Carre novels and single malt. Christmas.'
class StopTake extends Error {}

if (execSync('tasklist /FO CSV /NH', { encoding: 'utf8' }).split('\n').some((l) => /chrome-headless-shell|playwright/i.test(l))) {
  console.log('HELD: another Playwright run is alive')
  process.exit(3)
}

function buyer() {
  const text = readFileSync('C:/Users/User/.cloudflare/paypal-sandbox.local.txt', 'utf8')
  const get = (k) => (text.match(new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)`, 'm')) ?? [])[1]
  return { email: get('PAYPAL_SANDBOX_BUYER_EMAIL'), password: get('PAYPAL_SANDBOX_BUYER_PASSWORD') }
}

rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })
// Headless Chrome sent 1440 x 900 frames with deviceScaleFactor 2 alone (23 Oct); the switch asks for 2x frames.
const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=2'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
const frames = []
let filming = true
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  if (!filming) return
  const file = join(FRAMES, `${String(frames.length).padStart(6, '0')}.jpg`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  // Timed by arrival on the beats' own clock: Chrome's metadata.timestamp ran about 5 s apart from Date.now (23 Oct).
  frames.push({ file, time: Date.now() / 1000 })
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})

const beats = []
let start = 0
// The moment filming stopped, taken before the browser closes (closing took about 5 s and was held on the last frame).
let stoppedAt = 0
const beat = (name) => { beats.push({ name, at: Math.round((Date.now() / 1000 - start) * 100) / 100 }); console.log(`${beats.at(-1).at}s ${name}`) }
const pause = (ms) => page.waitForTimeout(ms)

try {
  await page.goto(BASE + '/')
  await page.locator('[data-example]').first().waitFor()
  await pause(500)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 2880, maxHeight: 1800, everyNthFrame: 1 })
  start = Date.now() / 1000
  beat('empty page')
  await pause(1800)
  await page.locator('#message').click()
  await page.keyboard.type(MESSAGE, { delay: 45 })
  await pause(500)
  beat('sent')
  await page.keyboard.press('Enter')
  await page.locator('.call-row').first().waitFor({ timeout: 60000 })
  beat('first Qloo call')
  await page.locator('.gift-card').first().waitFor({ timeout: 120000 })
  beat('first card')
  await page.locator('.gift-card').nth(4).waitFor({ timeout: 60000 })
  await pause(2500)
  beat('cards in')
  await page.locator('#chat-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight / 3, behavior: 'smooth' }))
  await pause(2500)
  await page.locator('.gift-card .call-link').nth(1).click()
  beat('panel at a card call')
  await pause(3000)
  await page.locator('.narrow-chip').scrollIntoViewIfNeeded()
  await pause(800)
  await page.locator('.narrow-chip').click()
  beat('narrowing sent')
  await page.locator('.card-list').nth(1).locator('.gift-card').first().waitFor({ timeout: 120000 })
  await pause(3000)
  beat('narrowed cards in')
  if (UNTIL === 'narrowed') throw new StopTake()
  const buy = page.locator('.card-list').nth(1).locator('[data-buy]').first()
  await buy.scrollIntoViewIfNeeded()
  await pause(800)
  await buy.click()
  beat('buy tapped')
  await pause(1500)
  if (PAY === 'testcard') {
    await page.locator('[data-pay="card"]').first().click()
    await page.locator('.pay-row.paid').waitFor({ timeout: 120000 })
  } else {
    await page.locator('[data-pay="paypal"]').first().click()
    await page.waitForURL(/sandbox\.paypal\.com/, { timeout: 60000 })
    beat('at PayPal')
    const { email, password } = buyer()
    const emailBox = page.locator('#email')
    if (await emailBox.isVisible({ timeout: 15000 }).catch(() => false)) {
      await emailBox.fill(email)
      await page.locator('#btnNext').click()
      await page.locator('#password').fill(password)
      await page.locator('#btnLogin').click()
    }
    const complete = page.getByRole('button', { name: /complete purchase|pay now/i }).first()
    await complete.waitFor({ timeout: 60000 })
    await pause(1500)
    await complete.click()
    beat('approved at PayPal')
    await page.waitForURL(/\/s\//, { timeout: 120000 })
    await page.locator('.pay-row.paid').waitFor({ timeout: 30000 })
  }
  await page.locator('.pay-row.paid').scrollIntoViewIfNeeded()
  beat('capture row')
  await pause(3500)
  beat('end')
} catch (e) {
  if (!(e instanceof StopTake)) throw e
  await pause(2500)
  beat('end')
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {})
  stoppedAt = Date.now() / 1000
  filming = false
  await context.close()
  await browser.close()
}

// Chrome sends a frame only when the page paints, so each frame is held until the next one. The first frame is shown
// from the moment filming started and the last is held to the end, so the film's clock is the beats' clock (23 Oct:
// without this a 23.1 s take came out 18.1 s, its quiet start and end cut, and the beats no longer matched).
const end = stoppedAt || Date.now() / 1000
const list = frames.map((f, i) => {
  const from = i === 0 ? Math.min(start, f.time) : f.time
  const next = i + 1 < frames.length ? frames[i + 1].time : Math.max(end, f.time + 1 / 60)
  return `file '${f.file.replace(/\\/g, '/')}'\nduration ${Math.max(next - from, 1 / 60).toFixed(4)}`
})
list.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`)
writeFileSync(join(FRAMES, 'list.txt'), list.join('\n') + '\n')
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(FRAMES, 'list.txt'),
  '-vf', 'fps=60,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', join(OUT, 'take.mp4')])
// The film starts at the first frame; the beats were timed from the screencast start, which is the same moment.
writeFileSync(join(OUT, 'beats.json'), JSON.stringify({ base: BASE, pay: PAY, frames: frames.length, seconds: Math.round((end - start) * 10) / 10, beats }, null, 1) + '\n')
rmSync(FRAMES, { recursive: true, force: true })
console.log(`filmed ${frames.length} frames into ${OUT}/take.mp4`)
