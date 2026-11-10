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
export const DECEMBER_FROM = Date.parse('2026-12-01T05:00:00Z')
export const DECEMBER_UNTIL = Date.parse('2026-12-16T05:00:00Z')
const VISITOR_WINDOWS = [
  [VISITOR_WINDOW_FROM, VISITOR_WINDOW_UNTIL],
  [DECEMBER_FROM, DECEMBER_UNTIL],
] as const
const inWindows = (windows: readonly (readonly [number, number])[], now: number) =>
  windows.some(([from, until]) => from <= now && now < until)
export const JUDGING_VISITOR_FACTOR = 4
// Inside the window a visitor may take 48 turns, 12 compares, 24 buys, 600 Qloo calls and 120 Channel3 calls a day,
// but every whole app total stays (2,000 Qloo calls, the 3,000 month floor, 300 Channel3 calls, the neuron share of
// 3,500 under the account cap of 9,500, under the free 10,000), so the spend ceiling is the same and judging still
// costs $0. Buys are PayPal sandbox orders (play money) and each model call is counted in the neuron share.
export function perVisitor(normal: number, now: number = clock.now()): number {
  return inWindows(VISITOR_WINDOWS, now) ? normal * JUDGING_VISITOR_FACTOR : normal
}

// Workers AI on the Workers Free plan: 10,000 neurons a day for the whole account, shared by the hackathon apps through
// the ledger. A first turn is about 100 neurons and up to about 410 (live, 6 Nov 2026), so 2,000 a day is about 20 live
// first turns (about 5 at the most), and 2,000 of 10,000 is 20% of the free day. The account cap stops every app before
// the free day is spent.
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
const NEURON_WINDOWS = [
  [JUDGING_FROM, JUDGING_UNTIL],
  [DECEMBER_FROM, DECEMBER_UNTIL],
] as const
// December's share is 3,500 a day. The shared account cap of 9,500 stops every app together before the free
// 10,000 a day, so December costs $0 too.
export function dailyNeuronShare(now: number = clock.now()): number {
  return inWindows(NEURON_WINDOWS, now) ? JUDGING_DAILY_NEURONS : DEFAULT_DAILY_NEURONS
}
// The most one Workers AI call may hold in the ledger. Before each call the code reserves that call's own worst case,
// callReserve in src/agent/model.ts: its input bound (UTF-8 bytes, never fewer than tokens) plus every output token it
// may write. A call whose worst case is over this is refused before it runs. So no call can cost more than it holds,
// and the daily and account caps are hard: the account cap of 9,500 stays under the free 10,000. 900 lets a present
// step of up to about 47,000 bytes run: (900 - 38.2) / 18,182 per million = 47,398. The largest real call in the
// ledger to 9 Nov 2026 cost 104.1 neurons. The default reserve, for a caller that names none, is this ceiling.
export const MAX_CALL_NEURONS = 900
// The room a new live turn needs before it starts. It is only a gate: every model call still reserves its own
// worst case in the ledger (one atomic insert that fails over the daily or account cap), so the caps stay hard and
// usage stays under the free 10,000 neurons a day: $0. The largest worst case held in the ledger to 9 Nov 2026 was
// 312 neurons; 400 gives room. With 900 here a turn was refused at 1,241 of 2,000 spent (9 Nov 2026).
export const TURN_START_NEURONS = 400

/** "Buy this one" taps per visitor a day. Each makes one PayPal sandbox order and one model call (at most 135 neurons). */
export const DAILY_BUYS_PER_VISITOR = 6
/** One model call and up to 12 Qloo calls, cached. */
export const DAILY_COMPARES_PER_VISITOR = 3

/** The pause between events of a cached or recorded run: a first turn of about 15 events reads in about 3 seconds. */
export const REPLAY_PACE_MS = 160

// 1,000 neurons at about 100 a first turn leaves about 10 first turns (about 2 at the most) after the public is spent,
// inside the app's 3,500, inside the account's 9,500, inside the free 10,000.
export const JUDGE_RESERVE_NEURONS = 1000
export const JUDGE_RESERVE_QLOO = 300
export const JUDGE_RESERVE_CHANNEL3 = 50
export const JUDGE_TURNS = 40
export const JUDGE_BUYS = 20
export const JUDGE_COMPARES = 10

export function publicLimit(total: number, reserve: number, judge: boolean, now = clock.now()): number {
  return !judge && inWindows(NEURON_WINDOWS, now) ? Math.max(0, total - reserve) : total
}

export function visitorLimit(normal: number, judge: boolean, judgeLimit = normal * 4, now = clock.now()): number {
  return judge && inWindows(VISITOR_WINDOWS, now) ? judgeLimit : perVisitor(normal, now)
}
