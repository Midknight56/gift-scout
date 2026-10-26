// Small text rules shared by the agent and its plan.

/** Model text on the page in plain words: no long dashes, no hyphen between two words ("Korean-Chinese" reads
 *  "Korean Chinese"). Names that come from Qloo are left as Qloo has them. */
export function plain(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/(\p{L})-(?=\p{L})/gu, '$1 ').replace(/\s{2,}/g, ' ').trim()
}

/** True when the words of `text` appear in what the person said (case and accents aside). */
export function saidIn(text: string, said: string[]): boolean {
  const fold = (s: string) => ' ' + s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '
  const want = fold(text)
  return want.trim() !== '' && said.some((s) => fold(s).includes(want))
}

/** The most they want to spend, when the message says so ("under 60 dollars", "below $30", "up to 100"). The model
 *  left budget_max out on a narrowing turn ("Make it cheaper, under 30 dollars.") and a $75 card stayed, so code reads it. */
export function budgetIn(text: string): number | undefined {
  const m = /\b(?:under|below|less than|at most|up to|max(?:imum)?|no more than)\s*(?:US\s*)?\$?\s*(\d{1,5})/i.exec(text)
  return m ? Number(m[1]) : undefined
}
