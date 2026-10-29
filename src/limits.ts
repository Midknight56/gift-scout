// The daily caps. Kept out of src/worker.ts: a Worker's entry module may export only handlers and classes.

// Upstream Qloo calls a day; cached answers are free and not counted. Qloo does not publish the hackathon key's quota
// ("set high enough to support typical hackathon projects"), so these caps keep one visitor or a script from spending it.
export const DAILY_QLOO_CALLS = 2000
export const DAILY_QLOO_CALLS_PER_VISITOR = 150
// The key's month is 50,000 calls (header read 25 Oct 2026), shared with two other apps at up to 500 a day each; under
// 3,000 left, Gift Scout stops live Qloo calls and serves cached answers and the recorded examples, so the other apps keep the rest.
export const QLOO_MONTH_FLOOR = 3000
// Channel3 search: 1 credit a call (docs.trychannel3.com/pricing, read 23 Oct 2026). The account has no payment
// method, so spent credits answer 402 and cost nothing. Its credits: 21,000 bonus plus 1,000 a month. 300 calls a
// day for 50 days is 15,000, inside the bonus. Cached answers are free and not counted.
export const DAILY_CHANNEL3_CALLS = 300
export const DAILY_CHANNEL3_CALLS_PER_VISITOR = 30
/** Live agent turns per visitor a day. Each costs neurons; a repeated example costs none (the run cache). */
export const DAILY_TURNS_PER_VISITOR = 12

export const clock = { now: (): number => Date.now() }
export const VISITOR_WINDOW_FROM = Date.parse('2026-11-02T00:00:00Z')
export const VISITOR_WINDOW_UNTIL = Date.parse('2026-11-06T12:00:00Z')
export const JUDGING_VISITOR_FACTOR = 4
// Inside the window a visitor may take 48 turns, 12 compares, 24 buys, 600 Qloo calls and 120 Channel3 calls a day,
// but every whole app total stays (2,000 Qloo calls, the 3,000 month floor, 300 Channel3 calls, the neuron share of
// 3,500 under the account cap of 9,500, under the free 10,000), so the spend ceiling is the same and judging still
// costs $0. Buys are PayPal sandbox orders (play money) and each model call is counted in the neuron share.
export function perVisitor(normal: number, now: number = clock.now()): number {
  return VISITOR_WINDOW_FROM <= now && now < VISITOR_WINDOW_UNTIL ? normal * JUDGING_VISITOR_FACTOR : normal
}

// Workers AI on the Workers Free plan: 10,000 neurons a day for the whole account, shared by the hackathon apps through
// the ledger. A full first turn was budgeted at about 120 neurons (6 model calls x about 2,500 input tokens x 4,625 per
// million = 69, plus about 1,500 output tokens x 30,475 per million = 46), so 2,000 a day is about 16 live first turns,
// and 2,000 of 10,000 is 20% of the free day. The account cap stops every app before the free day is spent.
export const DEFAULT_DAILY_NEURONS = 2000
export const DEFAULT_ACCOUNT_NEURONS = 9500
// The shares of the apps that use the shared ledger are Circlekeeper 700, Dispute Desk 700, Job Done 2,000, Running Tab
// 1,500 and Gift Scout 3,500 during judging, a total of 8,400. That is under the account cap of 9,500, which is under
// the free 10,000 a day, so judging still costs $0. Outside the judging days the total is 6,900. The judging days are
// 2 to 5 Nov 2026 (the Qloo hackathon overview, read 24 Oct 2026). Eastern time is UTC minus 5 on those days (daylight
// time ends 1 Nov 2026), so the share starts at 2 Nov 00:00 Eastern and drops back by itself at 5 Nov 23:45 Eastern.
export const JUDGING_DAILY_NEURONS = 3500
export const JUDGING_FROM = Date.parse('2026-11-02T05:00:00Z')
export const JUDGING_UNTIL = Date.parse('2026-11-06T04:45:00Z')
export function dailyNeuronShare(now: number = clock.now()): number {
  return JUDGING_FROM <= now && now < JUDGING_UNTIL ? JUDGING_DAILY_NEURONS : DEFAULT_DAILY_NEURONS
}
// The room held in the ledger before each Workers AI call; the row then takes the call's real cost, even when that is
// more. Measured in the shared ledger: 23 Oct 2026, 42 calls, largest 33.3, mean 21.9; 24 Oct, 65 calls, largest 48.4,
// mean 29.3. Reserve = the largest x 1.5 = 48.4 x 1.5 = 72.6, rounded up to 73. A call over 73 can pass the cap only by
// its own excess, and the account cap leaves 500 of the free 10,000 for that.
export const MAX_CALL_NEURONS = 73

/** "Buy this one" taps per visitor a day. Each makes one PayPal sandbox order and costs about 10 neurons. */
export const DAILY_BUYS_PER_VISITOR = 6
/** One model call and up to 12 Qloo calls, cached. */
export const DAILY_COMPARES_PER_VISITOR = 3

/** The pause between events of a cached or recorded run: a first turn of about 15 events reads in about 3 seconds. */
export const REPLAY_PACE_MS = 160
