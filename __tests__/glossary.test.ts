import { describe, expect, it } from '@jest/globals'
import { correctNames, nameReferences, parseNames, whisperNameHint } from '../src/engine/glossary'

const names = parseNames('Takeshi = タケシ\nAhmad bin Ismail\nKumar\n\nkumar')

describe('parseNames', () => {
  it('reads one entry per line, with an optional rendering, without duplicates', () => {
    expect(names).toEqual([{ term: 'Takeshi', rendering: 'タケシ' }, { term: 'Ahmad bin Ismail' }, { term: 'Kumar' }])
    expect(parseNames('Siti, Ravi')).toEqual([{ term: 'Siti' }, { term: 'Ravi' }])
  })
})

describe('correctNames', () => {
  it('repairs names the recogniser split or misheard', () => {
    expect(correctNames('My friend Taka she recommended one.', names)).toBe('My friend Takeshi recommended one.')
    expect(correctNames('Please tell I had been a smile that I will call him.', names)).toBe('Please tell Ahmad bin Ismail that I will call him.')
    expect(correctNames('under the name kumar.', names)).toBe('under the name Kumar.')
  })
  it('leaves ordinary words alone', () => {
    expect(correctNames('It takes about 20 minutes.', names)).toBe('It takes about 20 minutes.')
    expect(correctNames('Take bus number 10.', names)).toBe('Take bus number 10.')
    expect(correctNames('What a nice smile.', names)).toBe('What a nice smile.')
    expect(correctNames('A good sense of humor.', names)).toBe('A good sense of humor.')
  })
})

describe('nameReferences', () => {
  it('keeps names as written for Latin targets and uses given renderings', () => {
    expect(nameReferences('Please tell Ahmad bin Ismail', names, 'ms')).toEqual(['Ahmad bin Ismail translates to Ahmad bin Ismail'])
    expect(nameReferences('My friend Takeshi', names, 'ja')).toEqual(['Takeshi translates to タケシ'])
    expect(nameReferences('Please tell Ahmad bin Ismail', names, 'ja')).toEqual([])
  })
})

describe('whisperNameHint', () => {
  it('lists the names', () => {
    expect(whisperNameHint(names)).toBe('Takeshi, Ahmad bin Ismail, Kumar.')
    expect(whisperNameHint([])).toBe('')
  })
})
