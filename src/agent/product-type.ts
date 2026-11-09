import type { GiftProduct } from '../channel3/client'
import { interestKey } from './text'

// Genre families for books. A listing is refused only when both sides name a family and they share none.
const GENRE_FAMILIES: [string, RegExp][] = [
  ['crime', /\b(?:mystery|mysteries|crime|thrillers?|suspense|detective|spy|espionage|noir)\b/i],
  ['fantasy', /\bfantasy\b/i],
  ['science fiction', /\b(?:science fiction|sci fi|scifi|space opera|dystopian)\b/i],
  ['romance', /\b(?:romance|romantic)\b/i],
  ['horror', /\bhorror\b/i],
  ['biography', /\b(?:biography|memoir|autobiography)\b/i],
  ['children', /\b(?:children|picture book)\b/i],
]

function families(genres: string[] | undefined): Set<string> {
  const found = new Set<string>()
  for (const genre of genres ?? []) {
    const text = genre.replace(/[^\p{L}\p{N}]+/gu, ' ')
    for (const [name, words] of GENRE_FAMILIES) if (words.test(text)) found.add(name)
  }
  return found
}

/** False only when the taste graph book and the listing both have known genre families and none is shared. */
export function genresAgree(entityGenres: string[] | undefined, productGenres: string[] | undefined): boolean {
  const a = families(entityGenres), b = families(productGenres)
  return !a.size || !b.size || [...a].some((name) => b.has(name))
}

// Specific accessories precede the objects they name. Unrecognized gift types stay ideas.
const types: [string, RegExp][] = [
  ['gift card', /\bgift (?:cards?|vouchers?|certificates?)\b/],
  ['subscription', /\bsubscriptions?\b/],
  // Classify merchandise before its subject: a guitar keychain is not a guitar.
  ['keychain', /\b(?:keychains?|key chains?|key rings?|keyrings?|key fobs?)\b/],
  ['replica', /\b(?:miniatures?|replicas?|scale models?)\b/],
  ['figurine', /\b(?:figurines?|figures?|statuettes?)\b/],
  ['plush', /\b(?:plush|plushies|stuffed toys?|stuffed animals?)\b/],
  ['toy', /\btoys?\b/],
  ['sticker', /\b(?:stickers?|decals?)\b/],
  ['magnet', /\bmagnets?\b/],
  ['pin', /\b(?:pins?|badges?)\b/],
  ['ornament', /\bornaments?\b/],
  ['strap', /\bstraps?\b/],
  ['accessory', /\b(?:holders?|openers?|cases?|covers?|stands?)\b/],
  ['poster', /\b(?:posters?|art prints?|wall art)\b/],
  ['shirt', /\b(?:shirts?|t shirts?|tees?)\b/],
  ['hoodie', /\b(?:hoodies?|sweatshirts?)\b/],
  ['mug', /\bmugs?\b/],
  ['glass', /\b(?:glass|glasses|tumblers?|drinkware|glassware)\b/],
  ['bottle', /\b(?:bottles?|whisky|whiskey|bourbon|scotch|wine|spirits|liquor)\b/],
  ['candle', /\bcandles?\b/],
  ['vinyl', /\b(?:vinyl|records?|lp)\b/],
  ['book', /\b(?:books?|novels?|paperback|hardback|hardcover|softcover|audiobook|ebook)\b/],
  ['notebook', /\b(?:notebooks?|journals?)\b/],
  ['puzzle', /\b(?:puzzles?|jigsaws?)\b/],
  ['game', /\b(?:board games?|card games?|video games?)\b/],
  ['guitar', /\bguitars?\b/],
  ['perfume', /\b(?:perfume|cologne|fragrance)\b/],
  ['coffee', /\bcoffee\b/],
  ['tea', /\btea\b/],
]

/** Explicit variants require positive evidence. A broad category cannot prove a size or model. */
function variants(value: string): Map<string, Set<string>> {
  const text = value.normalize('NFKC').toLowerCase().replace(/[\u2010-\u2015-]/g, ' ')
  const result = new Map<string, Set<string>>()
  const add = (kind: string, value: string) => {
    const values = result.get(kind) ?? new Set<string>()
    values.add(value); result.set(kind, values)
  }
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:years?|yrs?|yo)\b/g)) add('age', String(Number(match[1])))
  const volumeUnits: Record<string, number> = { ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
    cl: 10, l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000, oz: 29.5735295625 }
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?(ml|cl|l|milliliters?|millilitres?|liters?|litres?|oz)\b/g)) {
    add('volume', String(Math.round(Number(match[1]) * volumeUnits[match[2]] * 1000) / 1000))
  }
  const sizes: Record<string, string> = { 'extra small': 'xs', small: 's', medium: 'm', large: 'l', 'extra large': 'xl',
    'extra extra large': 'xxl', '2xl': 'xxl' }
  const sizeKey = (size: string) => sizes[size.trim()] ?? size.trim()
  for (const match of text.matchAll(/\bsize\s*:?\s*(extra extra large|extra large|extra small|small|medium|large|xxxl|xxl|2xl|xl|xs|s|m|l|\d+(?:\.\d+)?)\b/g)) add('size', sizeKey(match[1]))
  // Apparel titles often omit the word "size".
  if (/\b(?:shirt|tee|hoodie|sweatshirt)s?\b/.test(text)) {
    for (const match of text.matchAll(/\b(extra extra large|extra large|extra small|small|medium|large|xxxl|xxl|2xl|xl|xs)\b/g)) add('size', sizeKey(match[1]))
  }
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(inch(?:es)?|cm|mm)\b/g)) {
    const factor = match[2].startsWith('inch') ? 25.4 : match[2] === 'cm' ? 10 : 1
    add('dimension', String(Math.round(Number(match[1]) * factor * 1000) / 1000))
  }
  const formats: [string, RegExp][] = [
    ['hardcover', /\b(?:hardcover|hardback|hard cover)\b/], ['paperback', /\b(?:paperback|softcover|softback)\b/],
    ['ebook', /\b(?:ebook|e book|kindle)\b/], ['audio', /\b(?:audiobook|audio book)\b/],
    ['vinyl', /\b(?:vinyl|lp)\b/], ['cd', /\bcd\b/], ['dvd', /\bdvd\b/], ['bluray', /\bblu ray\b/],
    ['digital', /\bdigital\b/], ['physical', /\bphysical\b/],
  ]
  for (const [format, words] of formats) if (words.test(text)) add('format', format)
  // Keep model codes intact except for spaces and punctuation. Do not mistake "750ml" for a model.
  const modelText = value.toLowerCase().normalize('NFKC')
  for (const match of modelText.matchAll(/\bmodel\s*:?\s*([a-z0-9]+(?:[- ][a-z0-9]+)?)/g)) {
    add('model', match[1].split(' ')[0].replace(/[^a-z0-9]/g, ''))
  }
  for (const match of modelText.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)*\b/g)) {
    const token = match[0]
    if (/[a-z]/.test(token) && /\d/.test(token) && !/^\d+(?:ml|cl|l|oz|cm|mm|yo|xl)$/.test(token)) add('model', token.replace(/-/g, ''))
  }
  return result
}

export function matchesGiftVariants(product: Pick<GiftProduct, 'title'>, gift: string): boolean {
  const required = variants(gift), actual = variants(product.title)
  for (const [kind, values] of required) {
    const found = actual.get(kind)
    if (!found || found.size !== values.size || [...values].some(value => !found.has(value))) return false
  }
  return true
}

/** Require evidence of the intended object, as well as the entity checked by pickProduct. */
export function matchesGiftType(product: GiftProduct, gift: string, entityName: string, entityType: string): boolean {
  if (!matchesGiftVariants(product, gift)) return false
  const entity = interestKey(entityName)
  const withoutEntity = (text: string) => (' ' + interestKey(text) + ' ').replace(' ' + entity + ' ', ' ').trim()
  const classify = (text: string) => types.find(([, words]) => words.test(text))?.[0]
  const intended = classify(withoutEntity(gift)) ?? (entityType === 'book' ? 'book' : undefined)
  if (!intended || intended === 'accessory') return false
  const title = withoutEntity(product.title)
  const titleType = classify(title)
  if (titleType && titleType !== intended) return false
  const category = product.category ? interestKey([product.category.slug, product.category.title, ...product.category.path].join(' ')) : ''
  const categoryType = classify(category)
  // A drinkware parent is compatible with a mug. Broad parents otherwise supply no evidence.
  if (categoryType && categoryType !== intended && !(intended === 'mug' && categoryType === 'glass')) return false
  // A Qloo book entity plus the title checks in pickProduct also identifies the book itself.
  return titleType === intended || categoryType === intended || (entityType === 'book' && intended === 'book' && !titleType && !categoryType)
}
