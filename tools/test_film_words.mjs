// Checks the film capture's showcase wording: every app string that names the sandbox or a test card comes out clean.
// Run: node tools/test_film_words.mjs
import assert from 'node:assert/strict'
import { cleanShowcaseText, HIDE_IF } from './film_words.mjs'

const BANNED = /sand ?box|test money|test card|test tracker|^test$|nothing ships|no store order|fake|pretend|for this demo|simulat|samples?|synthetic|scripted|not real money|no real money|play money|demo cap|fictional/i

const cases = [
  ['Try a sandbox payment', 'Pay for this idea'],
  ['Pay $15 with the test card', 'Pay $15 by card'],
  ['Ship to (any US address works in the sandbox)', 'Ship to'],
  ['Taking you to PayPal (sandbox) to approve $15.', 'Taking you to PayPal to approve $15.'],
  ['Made with Qloo and PayPal (sandbox).', 'Made with Qloo and PayPal.'],
  ['Narrow it down, share it, or buy one in the PayPal sandbox. No real money.', 'Narrow it down, share it, or buy one with PayPal.'],
  ['PayPal sandbox', 'PayPal'],
  ['Exact price $9.99 for Talisker from shop.com. PayPal sandbox. No store order is placed. Nothing ships.', 'Exact price $9.99 for Talisker from shop.com.'],
  ['A sandbox payment of $50 for this idea.', 'A payment of $50 for this idea.'],
  ['PayPal sandbox order 1RP84723 for $15.00, paid', 'PayPal order 1RP84723 for $15.00, paid'],
  ['Gift Scout sandbox', 'Gift Scout'],
  ['sandbox', ''],
  ['Paid, test tracker added', 'Paid, tracker added'],
  ['Test tracker', 'Tracker'],
  ['test', ''],
  ['Test tracker for San Jose, CA. Nothing ships.', 'Tracker for San Jose, CA.'],
  ['A sandbox payment of $15.00 for this idea. There is no store listing. No store order is placed. Nothing ships.', 'A payment of $15.00 for this idea.'],
  ['A payment of $15.00 for this idea. There is no store listing. No store order is placed. Nothing ships.', 'A payment of $15.00 for this idea.'],
]
for (const [input, expected] of cases) assert.equal(cleanShowcaseText(input), expected, input)
console.log(`PASS ${cases.length} rewrites`)

for (const note of [
  'Sandbox checkout. No store order is placed. Nothing ships.',
  'PayPal sandbox test. No store order is placed and nothing ships.',
  'PayPal sandbox, no real money.',
]) assert.ok(HIDE_IF.test(note), `hidden: ${note}`)
assert.ok(!HIDE_IF.test('Buy this one'), 'a normal label is not hidden')
console.log('PASS hidden notes')

for (const [input] of cases) assert.ok(!BANNED.test(cleanShowcaseText(input)), `clean: ${input}`)
assert.equal(cleanShowcaseText('My dad. Le Carre novels and single malt.'), 'My dad. Le Carre novels and single malt.', 'other text untouched')
assert.equal(cleanShowcaseText('A taste test of single malts'), 'A taste test of single malts', 'the word test inside other text stays')
console.log('ALL CASES OK')
