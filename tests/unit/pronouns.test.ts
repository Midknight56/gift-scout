import { describe, expect, it } from 'vitest'
import { fixWhyPronouns, pronounsFromMessage } from '../../src/agent/pronouns'

describe('pronouns from a message', () => {
  it('reads whole words without case sensitivity', () => {
    expect(pronounsFromMessage('MY BROTHER loves baking')).toBe('he')
    expect(pronounsFromMessage('Her SISTER loves baking')).toBe('she')
    expect(pronounsFromMessage('The brothers love baking')).toBeNull()
  })

  it('leaves mixed or they messages unknown', () => {
    expect(pronounsFromMessage('my brother and his wife')).toBeNull()
    expect(pronounsFromMessage('My brother says they love baking')).toBeNull()
    expect(pronounsFromMessage('They love baking')).toBeNull()
  })
})

describe('why pronouns', () => {
  it('changes female words to male words while keeping capitals', () => {
    expect(fixWhyPronouns("A stylish addition that matches her love for Taylor Swift's fashion sense.", 'he'))
      .toBe("A stylish addition that matches his love for Taylor Swift's fashion sense.")
    expect(fixWhyPronouns('a gift for her.', 'he')).toBe('a gift for him.')
    expect(fixWhyPronouns('a gift for her, which she will use daily.', 'he')).toBe('a gift for him, which he will use daily.')
    expect(fixWhyPronouns('She will love it.', 'he')).toBe('He will love it.')
  })

  it('changes male words to female words', () => {
    expect(fixWhyPronouns('his kitchen', 'she')).toBe('her kitchen')
    expect(fixWhyPronouns('made for him', 'she')).toBe('made for her')
    expect(fixWhyPronouns('This is his.', 'she')).toBe('This is hers.')
    expect(fixWhyPronouns('He made it himself.', 'she')).toBe('She made it herself.')
  })

  it('leaves words inside larger words alone', () => {
    expect(fixWhyPronouns('Hershey and the gift.', 'he')).toBe('Hershey and the gift.')
    expect(fixWhyPronouns('Hershey and the gift.', 'she')).toBe('Hershey and the gift.')
  })
})
