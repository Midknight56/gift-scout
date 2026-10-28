// What the agent tells the page while it works. POST /api/scout answers with one JSON object per line (NDJSON), in
// this order: `run` first, then any mix of `say`, `call`, `result`, then `cards`, `usage`, and `done` last. An `error`
// may come at any point and is then followed by `done`. A replayed or cached run sends the same events it sent live.

/** One entity the taste graph returned, as the panel and the cards show it. */
export interface Found {
  id: string
  name: string
  /** brand, book, place, podcast, destination, artist, movie, person, tv_show, video_game */
  type: string
  /** 0 to 1, from Qloo. Absent for search results. */
  affinity?: number
  /** Named entity seeds and their share of Qloo's explanation, in descending order. */
  shares?: { name: string; share: number }[]
  detail?: string
  address?: string
  price?: number
}

/** A real item found for this card by Channel3. */
export interface CardProduct {
  title: string
  brand?: string
  price: number
  url: string
  image?: string
  source: 'channel3'
}

/** A gift idea that survived the check: its entity came back from a taste_insights call in this conversation. */
export interface Card {
  /** Stable within a conversation: "c1", "c2", ... */
  id: string
  /** What to give, in a few words, for example "A Fender guitar strap". */
  gift: string
  /** One plain sentence for the person, written by the model. */
  why: string
  price_low: number
  price_high: number
  /** The Qloo entity the idea rests on, copied from the tool result by code, never by the model. */
  entity: Found
  /** The names of the seeds of the taste_insights call that returned the entity. */
  seeds: string[]
  /** Qloo's share for each named entity seed, copied from the result by code. */
  seed_shares?: { name: string; share: number }[]
  /** Tag seeds from the same call, which Qloo does not include in its entity split. */
  tag_seeds?: string[]
  /** Which call in the panel returned it (the `n` of that call). */
  from_call: number
  /** Optional real product used as the exact amount when this card is purchased. */
  product?: CardProduct
}

export interface Dropped { gift: string; reason: string }

export type ScoutEvent =
  | { t: 'owner'; token: string }
  /** `off`: live scouting cannot run now and there is no recording for this message; an `error` follows. */
  | { t: 'run'; conversation: string; turn: number; mode: 'live' | 'cache' | 'replay' | 'off'; recorded_at?: string; said?: string; purpose?: 'buy' | 'compare' }
  | { t: 'say'; text: string }
  /** A tool call the model made. `n` counts calls across the conversation, from 1. */
  | { t: 'call'; n: number; tool: string; args: Record<string, unknown> }
  /** The answer to call `n`. `top` holds at most 8 entities or tags; `cached` means Qloo was not asked again. */
  | { t: 'result'; n: number; tool: string; ok: boolean; ms: number; cached: boolean; text: string; top: Found[] }
  | { t: 'cards'; cards: Card[]; dropped: Dropped[] }
  /** The plain model picks and their Qloo scores against the conversation seeds. */
  | { t: 'compare'; plain: { gift: string; name: string; kind: string; found: boolean; affinity?: number }[]; plain_mean: number | null; qloo_mean: number | null; not_found: number }
  | { t: 'usage'; model_calls: number; neurons: number }
  | { t: 'error'; text: string }
  /** A PayPal sandbox order made by buy_gift, for the buyer to approve at `approve_url`. */
  | { t: 'order'; card: string; gift: string; order_id: string; amount: string; approve_url?: string; method?: 'paypal' | 'card'; product_title?: string; product_url?: string }
  /** The order was approved and captured. */
  | { t: 'paid'; card: string; gift: string; order_id: string; capture_id: string; amount: string; at: string; product_title?: string; product_url?: string }
  /** A PayPal tracker was added to the capture. `ship_to` is the city and state only: a share link never shows the street. */
  | { t: 'shipped'; card: string; order_id: string; capture_id: string; tracker_id: string; tracking_number: string; ship_to?: string; at: string }
  /** The buyer changed their mind and the capture was refunded in full. */
  | { t: 'refunded'; card: string; gift: string; order_id: string; capture_id: string; refund_id: string; amount: string; at: string }
  | { t: 'done'; share: string }
