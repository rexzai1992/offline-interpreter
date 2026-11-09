import { describe, expect, it, test } from '@jest/globals'

import { LANGUAGES, LANGUAGE_LIST, whisperCodeToLanguage } from '../src/languages'

describe('whisperCodeToLanguage', () => {
  it('maps a known whisper code to the matching language', () => {
    expect(whisperCodeToLanguage('en', [])).toBe('en')
    expect(whisperCodeToLanguage('ja', [])).toBe('ja')
    expect(whisperCodeToLanguage('tl', [])).toBe('tl')
  })

  it('treats Indonesian ("id") as Malay', () => {
    expect(whisperCodeToLanguage('id', [])).toBe('ms')
    expect(whisperCodeToLanguage('id', ['en', 'ms'])).toBe('ms')
  })

  it('prefers a candidate when several languages share a whisper code', () => {
    expect(whisperCodeToLanguage('zh', ['zh-Hant', 'en'])).toBe('zh-Hant')
    expect(whisperCodeToLanguage('zh', ['en', 'zh-Hans'])).toBe('zh-Hans')
  })

  it('falls back to the first definition sharing the code when no candidate matches', () => {
    const first = LANGUAGE_LIST.find((d) => d.whisper === 'zh')!
    expect(whisperCodeToLanguage('zh', ['en', 'ja'])).toBe(first.code)
    expect(whisperCodeToLanguage('zh', [])).toBe('zh-Hans')
  })

  it('is case-insensitive', () => {
    expect(whisperCodeToLanguage('EN', [])).toBe('en')
    expect(whisperCodeToLanguage('Id', [])).toBe('ms')
  })

  it('returns null for unknown codes', () => {
    expect(whisperCodeToLanguage('xx', [])).toBeNull()
    expect(whisperCodeToLanguage('', ['en'])).toBeNull()
    expect(whisperCodeToLanguage('fr', ['en', 'ja'])).toBeNull()
  })

  it('round-trips every defined language', () => {
    for (const def of LANGUAGE_LIST) {
      expect(whisperCodeToLanguage(def.whisper, [def.code])).toBe(def.code)
    }
    expect(Object.keys(LANGUAGES)).toHaveLength(LANGUAGE_LIST.length)
  })
})
