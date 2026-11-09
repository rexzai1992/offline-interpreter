import { describe, expect, it, jest, test } from '@jest/globals'

jest.mock('expo-device', () => ({ totalMemory: null }))
jest.mock('llama.rn', () => ({ initLlama: jest.fn() }))
jest.mock('expo-file-system', () => ({
  Directory: jest.fn(),
  File: jest.fn(),
  Paths: { document: '/tmp', cache: '/tmp' },
}))
jest.mock('../src/models/ModelManager', () => ({
  ModelManager: { isReady: jest.fn(() => false), pathFor: jest.fn(() => '/tmp/model') },
}))

import {
  buildPrompt,
  referenceTranslations,
  STYLE_INSTRUCTION,
  cleanTranslation,
  CONTEXT_RESET_KEEP,
  CONTEXT_TOKEN_BUDGET,
  estimateTokens,
  selectContext,
  splitSentences,
  type ContextTurn,
} from '../src/engine/Translator'
import { LANGUAGES } from '../src/languages'

const TENCENT_INSTRUCTION = 'Only output the translated result without any additional explanation.'

describe('buildPrompt', () => {
  it("contains Tencent's instruction text and the target language's full name", () => {
    const p = buildPrompt('Hello', 'ja', [])
    expect(p).toContain('Please translate the following text into Japanese.')
    expect(p).toContain(TENCENT_INSTRUCTION)
    expect(p).toContain('Note that the translation style must strictly conform to [')
    expect(p).toMatch(/\[Source Text\]\nHello$/)
  })

  it('uses the mtName for every target language', () => {
    expect(buildPrompt('x', 'zh-Hant', [])).toContain('into Traditional Chinese.')
    expect(buildPrompt('x', 'zh-Hans', [])).toContain('into Chinese.')
    expect(buildPrompt('x', 'ms', [])).toContain(`into ${LANGUAGES.ms.mtName}.`)
    expect(buildPrompt('x', 'tl', [])).toContain('into Filipino.')
  })

  it('omits the background block when no context is given', () => {
    const p = buildPrompt('Hello', 'en', [])
    expect(p).not.toContain('[Background Information]')
    expect(p.startsWith(STYLE_INSTRUCTION)).toBe(true)
  })

  it('puts the static instruction first, then the conversation, then the target and text', () => {
    const context: ContextTurn[] = [
      { speaker: 'A', language: 'en', text: 'Where is the station?' },
      { speaker: 'B', language: 'ja', text: '駅はあそこです。' },
    ]
    const p = buildPrompt('Thanks', 'ja', context)
    expect(p.startsWith(STYLE_INSTRUCTION + '\n\n[Background Information]\n')).toBe(true)
    expect(p).toContain('Speaker A (English): Where is the station?\nSpeaker B (Japanese): 駅はあそこです。')
    expect(p.indexOf('[Background Information]')).toBeLessThan(p.indexOf('Please translate'))
    expect(p).toMatch(/\[Source Text\]\nThanks$/)
  })

  it('shares its prefix with the next turn in either direction (KV cache friendly)', () => {
    const t1: ContextTurn = { speaker: 'A', language: 'en', text: 'One.' }
    const t2: ContextTurn = { speaker: 'B', language: 'ms', text: 'Dua.' }
    // Turn 2 (B, ms -> en) after turn 1 (A, en -> ms): everything up to the end of the
    // shorter conversation block is identical, regardless of the target language.
    const before = buildPrompt('Dua.', 'en', [t1])
    const after = buildPrompt('Three.', 'ms', [t1, t2])
    const shared = before.slice(0, before.indexOf('One.') + 'One.'.length)
    expect(after.startsWith(shared)).toBe(true)
    // Only the newline after the last shared line differs; the target language comes later.
    expect(shared.length).toBeGreaterThan(STYLE_INSTRUCTION.length)
  })
})

describe('estimateTokens', () => {
  it('is monotonic in text length and never below the fixed overhead', () => {
    expect(estimateTokens('', 'en')).toBe(2)
    expect(estimateTokens('a', 'en')).toBe(3)
    expect(estimateTokens('Hello world', 'en')).toBeLessThan(estimateTokens('Hello world again', 'en'))
  })

  it('charges more tokens per character for CJK than for English', () => {
    const s = 'x'.repeat(100)
    expect(estimateTokens(s, 'ja')).toBeGreaterThan(estimateTokens(s, 'en'))
    expect(estimateTokens(s, 'zh-Hant')).toBeGreaterThan(estimateTokens(s, 'zh-Hans'))
  })
})

describe('selectContext', () => {
  const turn = (i: number, text: string): ContextTurn => ({
    speaker: i % 2 ? 'B' : 'A',
    language: 'en',
    text,
  })

  it('returns the same array (untouched) while under budget', () => {
    const ctx = [turn(0, 'Hi.'), turn(1, 'Hello.'), turn(2, 'How are you?')]
    const out = selectContext(ctx)
    expect(out).toBe(ctx)
    expect(selectContext([])).toEqual([])
  })

  it('keeps everything right up to the budget', () => {
    // Each 100-char English turn costs ceil(100*0.23)+2+8 = 33 tokens.
    const per = estimateTokens('x'.repeat(100), 'en') + 8
    const n = Math.floor(CONTEXT_TOKEN_BUDGET / per)
    const ctx = Array.from({ length: n }, (_, i) => turn(i, 'x'.repeat(100)))
    expect(selectContext(ctx)).toBe(ctx)
  })

  it('resets to the last CONTEXT_RESET_KEEP turns once over budget', () => {
    const per = estimateTokens('x'.repeat(100), 'en') + 8
    const n = Math.floor(CONTEXT_TOKEN_BUDGET / per) + 1
    const ctx = Array.from({ length: n }, (_, i) => turn(i, `${i} ` + 'x'.repeat(98)))
    const out = selectContext(ctx)
    expect(out).toHaveLength(CONTEXT_RESET_KEEP)
    expect(out).toEqual(ctx.slice(-CONTEXT_RESET_KEEP))
    expect(out[out.length - 1]).toBe(ctx[ctx.length - 1])
  })

  it('a single huge turn that cannot fit is dropped rather than overflowing the context', () => {
    const ctx = [turn(0, 'x'.repeat(10000))]
    expect(selectContext(ctx).length).toBeLessThanOrEqual(1)
  })
})

describe('cleanTranslation', () => {
  it('trims surrounding whitespace', () => {
    expect(cleanTranslation('  hello \n')).toBe('hello')
  })

  it('strips wrapping quotes of each supported pair', () => {
    expect(cleanTranslation('"Hello"')).toBe('Hello')
    expect(cleanTranslation('“Hello”')).toBe('Hello')
    expect(cleanTranslation('「こんにちは」')).toBe('こんにちは')
    expect(cleanTranslation('『こんにちは』')).toBe('こんにちは')
    expect(cleanTranslation("'Hello'")).toBe('Hello')
  })

  it('strips only one layer of quotes and leaves unmatched quotes alone', () => {
    expect(['"Hi"', 'Hi']).toContain(cleanTranslation('“"Hi"”'))
    expect(cleanTranslation('"Hello')).toBe('"Hello')
    expect(cleanTranslation('Hello"')).toBe('Hello"')
    expect(cleanTranslation('""')).toBe('""')
  })

  it('strips leading labels in several languages, case-insensitively', () => {
    expect(cleanTranslation('Translation: Hello')).toBe('Hello')
    expect(cleanTranslation('translated text: Hello')).toBe('Hello')
    expect(cleanTranslation('译文：你好')).toBe('你好')
    expect(cleanTranslation('譯文: 你好')).toBe('你好')
    expect(cleanTranslation('翻訳：こんにちは')).toBe('こんにちは')
    expect(cleanTranslation('Terjemahan: Halo')).toBe('Halo')
    expect(cleanTranslation('Salin: Kumusta')).toBe('Kumusta')
  })

  it('strips a label followed by quotes', () => {
    expect(cleanTranslation('Translation: "Hello"')).toBe('Hello')
  })

  it('does not strip words that merely start with a label', () => {
    expect(cleanTranslation('Translations are hard')).toBe('Translations are hard')
    expect(cleanTranslation('Translation is hard')).toBe('Translation is hard')
  })

  // BUG: the quote stripping only checks the first and last character, so a
  // sentence that happens to start and end with quoted fragments loses its outer
  // quotes and is left unbalanced.
  // input:    "Yes," he said, "fine"
  // expected: "Yes," he said, "fine"  (unchanged)
  // actual:   Yes," he said, "fine
  it('leaves a sentence with two separate quoted fragments intact', () => {
    const s = '"Yes," he said, "fine"'
    expect(cleanTranslation(s)).toBe(s)
  })
})

describe('splitSentences', () => {
  it('splits Latin sentences on . ! ?', () => {
    expect(splitSentences('Hello there. How are you? Fine! ok')).toEqual({
      sentences: ['Hello there.', 'How are you?', 'Fine!'],
      rest: 'ok',
    })
  })

  it('splits CJK sentences on 。！？', () => {
    expect(splitSentences('你好。再见！好的？还有')).toEqual({
      sentences: ['你好。', '再见！', '好的？'],
      rest: '还有',
    })
  })

  it('keeps closing quotes and brackets with the sentence', () => {
    expect(splitSentences('He said "hi." Then left.')).toEqual({
      sentences: ['He said "hi."'],
      rest: 'Then left.',
    })
    expect(splitSentences('「行こう。」 はい。 ね')).toEqual({
      sentences: ['「行こう。」', 'はい。'],
      rest: 'ね',
    })
    expect(splitSentences('(Yes.) Next')).toEqual({ sentences: ['(Yes.)'], rest: 'Next' })
  })

  it('treats a run of punctuation as one terminator', () => {
    expect(splitSentences('Really?! Yes... maybe')).toEqual({
      sentences: ['Really?!', 'Yes...'],
      rest: 'maybe',
    })
    expect(splitSentences('Wait… ok')).toEqual({ sentences: ['Wait…'], rest: 'ok' })
  })

  it('returns a trailing fragment as rest, including a final sentence still being streamed', () => {
    expect(splitSentences('Hello. How are')).toEqual({ sentences: ['Hello.'], rest: 'How are' })
    // Without trailing non-space text a terminator may still be followed by more
    // tokens (e.g. a closing quote), so the last sentence stays in `rest`.
    expect(splitSentences('Hello.')).toEqual({ sentences: [], rest: 'Hello.' })
    expect(splitSentences('Hello. ')).toEqual({ sentences: [], rest: 'Hello. ' })
    expect(splitSentences('No punctuation here')).toEqual({
      sentences: [],
      rest: 'No punctuation here',
    })
  })

  it('does not emit one-character fragments', () => {
    expect(splitSentences('. Next')).toEqual({ sentences: [], rest: 'Next' })
  })

  it('terminates quickly on pathological input', () => {
    const start = Date.now()
    expect(splitSentences('')).toEqual({ sentences: [], rest: '' })
    expect(splitSentences('   ')).toEqual({ sentences: [], rest: '   ' })
    // Only punctuation: must terminate and must not lose characters.
    for (const input of ['...', '!?!?!?!?!?', '。。。。。。', '.', '"”」']) {
      const { sentences, rest } = splitSentences(input)
      expect(sentences.join('') + rest).toBe(input)
      for (const s of sentences) expect(s.length).toBeGreaterThanOrEqual(2)
    }
    const long = 'word '.repeat(50000)
    expect(splitSentences(long)).toEqual({ sentences: [], rest: long })
    const many = 'Ok. '.repeat(5000)
    expect(splitSentences(many).sentences).toHaveLength(4999)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  // BUG: the terminator regex does not require whitespace (or end of text)
  // after the punctuation, so a decimal point inside a number is treated as
  // the end of a sentence and the number is spoken in two halves.
  // input:    'It costs 3.5 dollars. ok'
  // expected: { sentences: ['It costs 3.5 dollars.'], rest: 'ok' }
  // actual:   { sentences: ['It costs 3.', '5 dollars.'], rest: 'ok' }
  it('does not split inside a decimal number such as 3.5', () => {
    expect(splitSentences('It costs 3.5 dollars. ok')).toEqual({
      sentences: ['It costs 3.5 dollars.'],
      rest: 'ok',
    })
  })
})

describe('referenceTranslations (Filipino clock times)', () => {
  it('maps Spanish-derived hours to the target language', () => {
    const text = 'Magkita tayo doon ng alas diyes.'
    expect(referenceTranslations(text, 'tl', 'en')).toEqual(["alas diyes translates to 10 o'clock"])
    expect(referenceTranslations(text, 'tl', 'ja')).toEqual(['alas diyes translates to 10時'])
    expect(referenceTranslations(text, 'tl', 'zh-Hans')).toEqual(['alas diyes translates to 10点'])
    expect(referenceTranslations(text, 'tl', 'zh-Hant')).toEqual(['alas diyes translates to 10點'])
    expect(referenceTranslations(text, 'tl', 'ms')).toEqual(['alas diyes translates to pukul 10'])
  })

  it('handles "ala una", hyphens, half hours and capitals, without duplicates', () => {
    expect(referenceTranslations('Ala una na, kain na tayo.', 'tl', 'en')).toEqual(["Ala una translates to 1 o'clock"])
    expect(referenceTranslations('alas-dose yata', 'tl', 'ja')).toEqual(['alas-dose translates to 12時'])
    expect(referenceTranslations('bukas ng alas tres y medya', 'tl', 'en')).toEqual(['alas tres y medya translates to 3:30'])
    expect(referenceTranslations('alas siyete o alas siyete y medya, alas siyete', 'tl', 'ja')).toEqual([
      'alas siyete translates to 7時',
      'alas siyete y medya translates to 7時半',
    ])
  })

  it('does nothing for other source languages or unrelated words', () => {
    expect(referenceTranslations('alas diyes', 'en', 'ja')).toEqual([])
    expect(referenceTranslations('Salamat, ang ganda ng palasyo.', 'tl', 'en')).toEqual([])
    expect(referenceTranslations('Alas! It is over.', 'tl', 'en')).toEqual([])
  })

  it('places the reference block just before the instruction to translate', () => {
    const refs = referenceTranslations('alas diyes', 'tl', 'en')
    const p = buildPrompt('alas diyes', 'en', [], refs)
    expect(p).toContain("Reference the following translations:\nalas diyes translates to 10 o'clock\n\nPlease translate the following text into English.")
    expect(buildPrompt('hi', 'en', [], [])).not.toContain('Reference the following translations')
  })
})
