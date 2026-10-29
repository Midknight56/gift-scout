// Small text rules shared by the agent and its plan.

/** Model text on the page in plain words: no long dashes, no hyphen between two words ("Korean-Chinese" reads
 *  "Korean Chinese"). Names that come from Qloo are left as Qloo has them. */
export function plain(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/(\p{L})-(?=\p{L})/gu, '$1 ').replace(/\s{2,}/g, ' ').trim()
}

function fold(s: string): string {
  return ' ' + s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '
}

/** True when the words of `text` appear in what the person said (case and accents aside). */
export function saidIn(text: string, said: string[]): boolean {
  const want = fold(text)
  return want.trim() !== '' && said.some((s) => fold(s).includes(want))
}

// True when the city's whole words were said with a capitalized first word.
export function nameSaidIn(text: string, said: string[]): boolean {
  const wanted = fold(text).trim().split(/\s+/).filter(Boolean)
  if (!wanted.length) return false
  return said.some((sentence) => {
    const matches = [...sentence.matchAll(/[\p{L}\p{N}]+/gu)]
    return matches.some((match, index) => {
      if (!/\p{Lu}/u.test(match[0][0]) || index + wanted.length > matches.length) return false
      return wanted.every((word, offset) => fold(matches[index + offset][0]).trim() === word)
    })
  })
}

// True when a significant word of a love matches something the person said after a small stem.
const ignoredWords = new Set(['the', 'and', 'for', 'with', 'from', 'food', 'music', 'book', 'books', 'gift', 'gifts', 'love', 'loves'])
const stem = (word: string) => word.replace(/(?:ings|ing|ers|er|ed|es|s)$/, '').replace(/([a-z])\1$/, '$1')
const significantWords = (s: string) => fold(s).trim().split(/\s+/)
  .filter((word) => !ignoredWords.has(word)).map(stem)
  .filter((word) => word.replace(/[0-9]/g, '').length >= 3 && !ignoredWords.has(word))

export function wordSaidIn(text: string, said: string[]): boolean {
  const spoken = new Set(said.flatMap(significantWords))
  return significantWords(text).some((word) => spoken.has(word))
}

// True when every significant stemmed query word is among the stemmed words of the tag name.
export function tagMatches(tagName: string, query: string): boolean {
  const wanted = significantWords(query)
  if (!wanted.length) return true
  const available = new Set(significantWords(tagName))
  return wanted.every((word) => available.has(word))
}

/** The most they want to spend, when the message says so ("under 60 dollars", "below $30", "up to 100"). The model
 *  left budget_max out on a narrowing turn ("Make it cheaper, under 30 dollars.") and a $75 card stayed, so code reads it. */
export function budgetIn(text: string): number | undefined {
  const m = /\b(?:under|below|less than|at most|up to|max(?:imum)?|no more than)\s*(?:US\s*)?\$?\s*(\d{1,5})/i.exec(text)
  return m ? Number(m[1]) : undefined
}
