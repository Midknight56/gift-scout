export type PronounSet = 'he' | 'she'

const MALE = /\b(?:brother|dad|father|son|husband|boyfriend|grandpa|grandfather|uncle|nephew|he|him|his)\b|\bmy\s+guy\b/i
const FEMALE = /\b(?:sister|mom|mum|mother|daughter|wife|girlfriend|grandma|grandmother|aunt|niece|she|her)\b/i
const THEY = /\bthey\b/i

export function pronounsFromMessage(message: string): PronounSet | null {
  if (THEY.test(message)) return null
  const male = MALE.test(message)
  const female = FEMALE.test(message)
  if (male === female) return null
  return male ? 'he' : 'she'
}

const HER_STOP_WORDS = new Set([
  'to', 'for', 'and', 'with', 'or', 'as', 'at', 'in', 'on', 'from', 'about', 'than',
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any',
])

function keepCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase()
  if (source[0] === source[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1)
  return replacement
}

export function fixWhyPronouns(why: string, pronoun: PronounSet): string {
  if (pronoun === 'he') {
    return why.replace(/\b(she|herself|hers|her)\b/gi, (word, _match, offset: number, text: string) => {
      const lower = word.toLowerCase()
      let replacement: string
      if (lower === 'she') replacement = 'he'
      else if (lower === 'herself') replacement = 'himself'
      else if (lower === 'hers') replacement = 'his'
      else {
        const rest = text.slice(offset + word.length)
        // Punctuation or the end after "her" means it is the object: "for her, which" is "for him, which".
        const terminal = /^\s*[,.;:!?…—-]/.test(rest) || !rest.trim()
        const nextWord = rest.match(/^\s*([\p{L}\p{N}_]+)/u)?.[1]?.toLowerCase()
        replacement = nextWord && !terminal && !HER_STOP_WORDS.has(nextWord) ? 'his' : 'him'
      }
      return keepCase(word, replacement)
    })
  }
  return why.replace(/\b(he|him|his|himself)\b/gi, (word, _match, offset: number, text: string) => {
    const lower = word.toLowerCase()
    const replacement = lower === 'he' ? 'she' : lower === 'him' ? 'her' : lower === 'himself' ? 'herself' : 'her'
    if (lower === 'his') {
      const rest = text.slice(offset + word.length)
      if (/^\s*[,.;:!?…]/.test(rest) || !rest.trim()) return keepCase(word, 'hers')
    }
    return keepCase(word, replacement)
  })
}
