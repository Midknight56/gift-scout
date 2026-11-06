// Small text rules shared by the agent and its plan.

/** Model text on the page in plain words: no long dashes, no hyphen between two words ("Korean-Chinese" reads
 *  "Korean Chinese"). Names that come from Qloo are left as Qloo has them. */
export function plain(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s*\u2014\s*/g, ', ').replace(/\s*\u2013\s*/g, ' ').replace(/(\p{L})-(?=\p{L})/gu, '$1 ').replace(/\s{2,}/g, ' ').trim()
}

function fold(s: string): string {
  return ' ' + s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '
}

/** A name key shared by saved interests and seed names. */
export function interestKey(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Read explicit withdrawals, including lists, without treating an added interest as a withdrawal. */
export function takenBack(message: string, interests: string[]): string[] {
  const names = new Map<string, string>()
  for (const name of interests) {
    const key = interestKey(name)
    if (key && !names.has(key)) names.set(key, name)
  }
  if (!names.size) return []
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length)
    .map((name) => name.split(' ').join('[^\\p{L}\\p{N}]+'))
  const name = `(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`
  const prefix = "(?:not(?!\\s+(?:only|just)\\b)|forget|drop|remove|skip|instead\\s+of|no\\s+longer\\s+likes?|(?:does|do)\\s+not\\s+like|(?:doesn't|don't)\\s+like|(?:is|are)\\s+over|stopped\\s+liking|(?:is|are)\\s+not\\s+into|isn't\\s+into|not\\s+a\\s+fan\\s+of|hates?|dislikes?|(?:is|are)\\s+tired\\s+of)"
  const list = `${name}(?:\\s*(?:,\\s*(?:(?:and|or)\\s+)?|(?:and|or|&)\\s+)${name})*`
  const withdrawals = new RegExp(`(?<![\\p{L}\\p{N}])(?:${prefix}\\s+(${list})|(?:no(?:\\s+more)?|without)\\s+(${list})(?=\\s*(?:$|,|\\.|\\bplease\\b|\\banymore\\b|\\bany\\s+more\\b|\\bthis\\s+time\\b|\\bbut\\b)))`, 'gu')
  const spoken = message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/’/g, "'")
  const dropped = new Set<string>()
  for (const match of spoken.matchAll(withdrawals)) {
    const matchedNames = new RegExp(`(?<![\\p{L}\\p{N}])${name}`, 'gu')
    for (const item of (match[1] ?? match[2]).matchAll(matchedNames)) dropped.add(interestKey(item[0]))
  }
  return [...names].filter(([key]) => dropped.has(key)).map(([, name]) => name)
}

/** True when the words of `text` appear in what the person said (case and accents aside). */
export function saidIn(text: string, said: string[]): boolean {
  const want = fold(text)
  return want.trim() !== '' && said.some((s) => fold(s).includes(want))
}

// A named city must occur in the person's words. An explicit residence phrase also permits lowercase.
export function nameSaidIn(text: string, said: string[]): boolean {
  const wanted = fold(text).trim().split(/\s+/).filter(Boolean)
  if (!wanted.length) return false
  if (/^(?:(?:the|a|an) )?(?:forest|woods|countryside|city|town|village|country|home|area|neighborhood|neighbourhood|mountains|beach|park)$/.test(wanted.join(' '))) return false
  return said.some((sentence) => {
    const matches = [...sentence.matchAll(/[\p{L}\p{N}]+/gu)]
    return matches.some((match, index) => {
      if (index + wanted.length > matches.length || !wanted.every((word, offset) => fold(matches[index + offset][0]).trim() === word)) return false
      const before = sentence.slice(0, match.index).split(/[.!?;]/).at(-1) ?? ''
      if (/\b(?:not|never|doesn't|don't|isn't|aren't|no longer)\b/i.test(before)) return false
      return /\p{Lu}/u.test(match[0][0]) || /\b(?:lives?|living|based|resides?|located)\s+in\s+$/i.test(before)
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
