# Gift Scout

Gift Scout finds a gift from what a person already loves. Tell it who the gift is for and a few things they love. It
asks Qloo's taste graph what the same audience loves, kind by kind, and comes back with six gift ideas. Each idea
shows Qloo's split of which favourite pulled it in. Then you can narrow it down, share it, and buy one in the PayPal
sandbox.

Try it: https://gift-scout.midknight-labs.workers.dev

## Judge in 60 seconds

1. Open https://gift-scout.midknight-labs.workers.dev and tap the example "My dad. Le Carre novels and single malt.
   Christmas." (or write your own person).
2. Watch "Behind the scenes" on the right fill with every Qloo call as it runs. Each of the six cards shows the Qloo
   result it rests on and Qloo's split of which love pulled it in.
3. Tap "Compare with Qloo off" under the cards: the same model with no Qloo, its ideas scored against the same loves.

Then "Buy this one" pays for a card in the PayPal sandbox, with the sandbox buyer below or PayPal's test card and no
login. Nothing here costs real money.

Built for this contest: work began on 22 Oct 2026. Everything in this repo was written after 1 Oct.

## What a run looks like

The "How it works" button in the top bar opens a sheet with four short steps.

1. You write: "My dad. Le Carre novels and single malt. Christmas."
2. The agent plans: John le Carré is an author, single malt is a drink.
3. It asks Qloo. One search per love (John le Carré comes back as an author, single malt as Lagavulin), then the taste
   graph for brands, books, podcasts and destinations, with both seeds together.
4. Qloo answers with what the same audience loves, each with an affinity from 0 to 1: Talisker 0.93, Isle of Jura
   0.93, Fallen Angel 0.90, The Infinite Monkey Cage 0.94, Ullapool 0.89.
5. The model writes six cards: what to give, a price band, one line on why. Each card shows Qloo's split of which
   favourite pulled it in, from `feature.explainability`, and links to the call that found it. For example:
   "Lagavulin 55%, John le Carré 45%". A love that is a tag, such as a cuisine, has no share and appears after the
   split.
6. "Make it cheaper, under 30 dollars." The agent reuses what it found and drops what no longer fits.
7. "Buy this one." The agent makes a PayPal sandbox order for that card. You approve it at PayPal, or pay with PayPal's
   sandbox test card with no login, and the capture shows up next to the Qloo calls.

   To approve at PayPal, sign in with this sandbox buyer. It is a test account with play money, not a real one.

   | Sandbox buyer | |
   | --- | --- |
   | Email | `sb-bzdbn21339224@personal.example.com` |
   | Password | `!_B%e5W%` |

The "Behind the scenes" panel lists every Qloo call. A plain line says what each call asked, above its raw arguments.
The line at the top counts completed Qloo calls and notes how many came from the cache when there are cached calls.
The panel shows the same favourite split under each result. A small picture at the top shows the walk from favourites
on the left to the Qloo results the cards rest on at the right. Line weight follows Qloo's split.

"Compare with Qloo off" uses the same message with the same Workers AI model and no tools. Each suggestion is looked
up in Qloo and scored against the same favourites with `filter.results.entities`, or marked "not found in Qloo". The
page shows both means side by side. There is one comparison per conversation and three per day per visitor (12 from 2
to 5 Nov, for judging). Only the
tab that started the conversation can compare it.

## How it uses Qloo

Qloo is the only source of the ideas. Without it there is nothing to suggest.

| Qloo call | What Gift Scout does with it |
| --- | --- |
| `GET /search` | Turns a name into an entity. With no type, Qloo ranks every kind together, so "Le Carre" finds the author. |
| `GET /v2/tags` | Turns a cuisine or a hobby into tags: "Korean" gives the Korean restaurant tag, "running" the running tag. |
| `GET /v2/insights` | Walks the graph from all the seeds together to brands, books, podcasts, destinations and places. Tags go in as signals (`signal.interests.tags`), a cuisine tag also filters places (`filter.tags`), a city keeps places local (`filter.location.query`), and who the gift is for goes in as an audience (`signal.demographics.gender`, `signal.demographics.age`) when the message makes it plain, such as "my dad". |

The person the gift is for goes to Qloo as an audience (`signal.demographics.gender` and
`signal.demographics.age`) only when the message makes it plain. The same three calls are also an MCP server at `/mcp`
(Streamable HTTP), so any MCP client can use Qloo through Gift Scout: `search_entities`, `search_tags` and
`taste_insights`.

## Why a card can be trusted

The model writes the gift and the sentence. Code does the rest:

- A card must rest on an entity that a Qloo insights call returned in this conversation. A card with no Qloo result
  behind it is dropped, and the panel says so.
- The affinity, the entity name and the seeds on a card are copied from the Qloo answer by code, never by the model.
- Gift ideas are grouped by kind. Code picks across the kinds, and drops an idea listed under the wrong kind.
- Cards over the budget (read from what the person wrote), under 5 dollars, or a third of one kind are dropped.
- A city the person never named is taken out of a call.

Safety:

- Only the tab that started a conversation can buy or compare from it. A signed token stays in that tab.
- Each AI call first holds 73 neurons of room under both caps, then the row takes the call's real cost.
- A card already paid for is not bought again. There is one open order per card.
- The PayPal webhook is verified and size limited. It records one paid row per order and checks the amount to the cent.
- A Qloo or PayPal failure is never saved as an answer.

## The agent

- A first message is plan, then present. The model makes one `plan_scout` call: each love and its kind (a named thing,
  a drink, a cuisine, a hobby), the city if one was named, the budget if one was given. Code then makes the same Qloo
  calls every time: one search per love and one insights call per kind of gift. The model then calls `present_gifts`.
  Two model calls per first message.
- A later message is a free tool loop: the model may search or ask the taste graph again, then present again.
- A name Qloo does not know is set aside and named, never used as a seed. If Qloo does not answer, the page says so.
- Buying is a separate turn after a tap on "Buy this one". Only then is the model offered `buy_gift`, and code lets it
  buy only the tapped card, for an amount inside its price band. The buyer can approve at PayPal, or pay on the server
  with PayPal's published sandbox test card, with no login.
- A verified PayPal webhook at `/api/paypal/webhook` captures an approved order if the buyer never comes back.
- A shared link previews its own conversation in the page title and link preview tags.
- The model runs on Cloudflare Workers AI.

## Running it

You need Node 22 or later, a Cloudflare account, a Qloo API key, and (for buying) a PayPal sandbox app.

```
npm install
npx wrangler d1 create gift-scout          # put its id and your account id in wrangler.jsonc
npx wrangler d1 migrations apply gift-scout --local
```

Make `.dev.vars` (it is never committed):

```
QLOO_API_KEY=...
SESSION_SECRET=any long random text
PAYPAL_CLIENT_ID=...
PAYPAL_SECRET=...
PAYPAL_WEBHOOK_ID=...
```

`PAYPAL_WEBHOOK_ID` is the id of a webhook you add to your PayPal sandbox app for `/api/paypal/webhook`. Without it the
webhook answers 503 and everything else still works.

Then:

```
npx wrangler dev          # http://127.0.0.1:8787
npm run gate              # type checks and the unit tests
npx playwright install chromium    # the test browser, once
node tools/e2e.mjs        # the play through against the local Worker
```

To deploy, set the same five values with `npx wrangler secret put`, apply the migrations with `--remote`, and run
`npx wrangler deploy`. The LEDGER binding in `wrangler.jsonc` points at a shared database that counts model use across
apps on one account; point it at your own database or remove it, and the app counts in its own database.

## Limits that keep it free

A visitor never costs money. Every model call is counted in neurons (Workers AI's own count) against a daily budget,
and each visitor has a daily number of turns. Every Qloo answer is cached for 60 days, so a repeated question costs
nothing, and the same first message is answered again from the first run. When live scouting is not possible (no
budget left, or no Qloo key), the three example messages replay recorded runs, marked as recorded with their date.

The replay data is not in this repository because Qloo's terms keep its answers out of public repositories. To make the three examples replay on your own deploy, run `tools/record_samples.py` and then `tools/seed_replay.py`.

## Receipts (PayPal sandbox, 23 Oct 2026)

| Check | Answer | Id |
| --- | --- | --- |
| Client credentials token | 200 | |
| Order of $25.00 (`custom_id gs-0001`) | 200, PAYER_ACTION_REQUIRED | 2LM8442027227624T |
| Approved by the sandbox buyer, then captured | 201, COMPLETED | 0TS78123T29977041 |
| Refund of that capture | 201, COMPLETED | 13N40111K28196435 |
| In the app: "Buy this one", then Pay at PayPal ($22.50) | order, then capture | 69H19202VR067963Y, 3AW65542MG1410110 |
| Order paid with PayPal's test card | 201, COMPLETED | 6FC350569T3264931, capture 2NK3927400558224G |
| Webhook: a forged event | 401 | |
| Webhook: a genuine PayPal event | 200, verified | WH-19E71976UR098271U-3H1177824C326720G |

## Files

| Path | What it holds |
| --- | --- |
| `src/agent/` | The agent: the plan, the tool loop, the card checks, the buy turn, the model client |
| `src/qloo/` | The Qloo client and the three tools |
| `src/paypal/` | The PayPal Orders v2 client |
| `src/app/` | The scout and buy endpoints |
| `src/mcp/` | The MCP server |
| `src/store/` | D1 storage: the Qloo cache, conversations, the neuron ledger |
| `public/` | The page |
| `tools/` | `demo_check.py` runs the three examples and judges them; `quality_check.py` checks ten messages a judge might type; `record_samples.py` records the examples; `public_check.py` scans before the repo goes public; `evening.py` runs the live checks as one command; `e2e.mjs` plays a visitor from the empty page to a paid gift in a browser; `phones.mjs` measures the page at 14 phone and tablet widths; `film.mjs` films the demo for the video |
| `tests/unit/` | 339 unit tests |

## Licence

MIT. See `LICENSE`.
