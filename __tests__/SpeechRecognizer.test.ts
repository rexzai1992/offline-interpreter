import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'

jest.mock('whisper.rn/index', () => ({
  initWhisper: jest.fn(),
  initWhisperVad: jest.fn(),
}))
jest.mock('@fugood/react-native-audio-pcm-stream', () => ({
  __esModule: true,
  default: { init: jest.fn(), start: jest.fn(), stop: jest.fn(), on: jest.fn() },
}))
jest.mock('expo-file-system', () => ({
  Directory: jest.fn(),
  File: jest.fn(),
  Paths: { document: '/tmp', cache: '/tmp' },
}))
jest.mock('../src/models/ModelManager', () => ({
  ModelManager: { isReady: jest.fn(() => false), pathFor: jest.fn(() => '/tmp/model') },
}))

import { encoderContextFor, cleanTranscript, detectedInPair, closestCandidate, looksLikeTransliteratedLatin, vadToSamples, languageFromScript, isMostlyLatin, hasMangledJapaneseNumber } from '../src/engine/SpeechRecognizer'

describe('cleanTranscript', () => {
  it('removes bracketed non-speech tags', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('')
    expect(cleanTranscript('[BLANK_AUDIO] Hello there')).toBe('Hello there')
    expect(cleanTranscript('Hello [inaudible] there [laughs]')).toBe('Hello there')
  })

  it('removes short latin parenthesised tags such as (music)', () => {
    expect(cleanTranscript('(music)')).toBe('')
    expect(cleanTranscript('(music) Good morning (applause)')).toBe('Good morning')
    expect(cleanTranscript('(foreign language)')).toBe('')
  })

  it('keeps latin parentheticals of 30 characters or more', () => {
    const exactly30 = '(speaking in foreign language)'
    expect(exactly30).toHaveLength(30)
    expect(cleanTranscript(exactly30)).toBe(exactly30)
    expect(cleanTranscript('(abcdefghijklmnopqrstuvwxyz1)')).toBe('')
  })

  it('keeps parentheses whose content has no latin letters', () => {
    expect(cleanTranscript('こんにちは (笑)')).toBe('こんにちは (笑)')
    expect(cleanTranscript('Total (3) items')).toBe('Total (3) items')
    expect(cleanTranscript('你好 (你好吗)')).toBe('你好 (你好吗)')
  })

  it('keeps long latin parentheticals that are likely real speech', () => {
    const long = 'He left (because the meeting ran much longer than expected) early'
    expect(cleanTranscript(long)).toBe(long)
  })

  it('collapses whitespace and trims', () => {
    expect(cleanTranscript('  Hello   \n  world \t ')).toBe('Hello world')
    expect(cleanTranscript('Hello [x]   world')).toBe('Hello world')
    expect(cleanTranscript('')).toBe('')
  })

  it('handles unbalanced brackets without throwing', () => {
    expect(cleanTranscript('Hello [world')).toBe('Hello [world')
    expect(cleanTranscript('Hello (world')).toBe('Hello (world')
  })

  it('removes CJK bracket tags 【】 and short full-width （） regardless of script', () => {
    expect(cleanTranscript('【音楽】こんにちは')).toBe('こんにちは')
    expect(cleanTranscript('こんにちは（笑）')).toBe('こんにちは')
    expect(cleanTranscript('你好（鼓掌）世界')).toBe('你好 世界')
    const long = '（明日の会議は午後三時から本社の第二会議室で行われる予定です）'
    expect(long.length).toBeGreaterThanOrEqual(30)
    expect(cleanTranscript(long)).toBe(long)
  })

  it('removes music notes and the lyrics between them', () => {
    expect(cleanTranscript('♪ la la la ♪')).toBe('')
    expect(cleanTranscript('♪♫ Hello')).toBe('Hello')
    expect(cleanTranscript('Hi ♪ song ♪ there')).toBe('Hi there')
  })

  it('removes short *action* markers but keeps long starred spans', () => {
    expect(cleanTranscript('*laughs* Hello *sigh*')).toBe('Hello')
    const long = '*the speaker leaves the room briefly*'
    expect(long.length).toBeGreaterThan(32)
    expect(cleanTranscript(long)).toBe(long)
  })

  describe('repetition loops', () => {
    let warn: ReturnType<typeof jest.spyOn>
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    })
    afterEach(() => {
      warn.mockRestore()
    })

    it('truncates a phrase repeated four or more times', () => {
      expect(cleanTranscript('Thank you. Thank you. Thank you. Thank you.')).toBe('Thank you.')
      expect(cleanTranscript('Hello okay okay okay okay then')).toBe('Hello okay')
      expect(warn).toHaveBeenCalled()
    })

    it('truncates a single character repeated eight or more times', () => {
      expect(cleanTranscript('Wait........ what')).toBe('Wait.')
    })

    it('keeps short text and up to three repetitions', () => {
      expect(cleanTranscript('no no no')).toBe('no no no')
      expect(cleanTranscript('Yes, yes, yes.')).toBe('Yes, yes, yes.')
      expect(cleanTranscript('aaaaaaa')).toBe('aaaaaaa')
      expect(cleanTranscript('Well... okay... fine... sure.')).toBe('Well... okay... fine... sure.')
      expect(warn).not.toHaveBeenCalled()
    })
  })
})

describe('encoderContextFor', () => {
  it('never goes below 512 positions (about 10 s) for short utterances', () => {
    expect(encoderContextFor(0)).toBe(512)
    expect(encoderContextFor(3000)).toBe(512)
    expect(encoderContextFor(9000)).toBe(512)
  })
  it('covers longer utterances plus one second, rounded up to 64', () => {
    // 12 s + 1 s = 13 s = 650 positions -> 704
    expect(encoderContextFor(12000)).toBe(704)
    expect(encoderContextFor(12000) * 20).toBeGreaterThanOrEqual(13000)
  })
  it('caps at the full 30 s window', () => {
    expect(encoderContextFor(29000)).toBe(1500)
    expect(encoderContextFor(60000)).toBe(1500)
  })
})

describe('auto-detect outside the selected pair', () => {
  it('recognises in-pair detections', () => {
    expect(detectedInPair('en', ['en', 'ja'])).toBe(true)
    expect(detectedInPair('ja', ['en', 'ja'])).toBe(true)
    expect(detectedInPair('zh', ['en', 'zh-Hant'])).toBe(true)
    expect(detectedInPair('id', ['ms', 'ja'])).toBe(true)
  })
  it('flags detections outside the pair (the field bug: English heard as Malay)', () => {
    expect(detectedInPair('ms', ['en', 'ja'])).toBe(false)
    expect(detectedInPair('ko', ['en', 'ja'])).toBe(false)
  })
  it('picks the closer selected language', () => {
    expect(closestCandidate('ms', ['en', 'ja'])).toBe('en')
    expect(closestCandidate('ms', ['ja', 'en'])).toBe('en')
    expect(closestCandidate('ko', ['en', 'ja'])).toBe('ja')
    expect(closestCandidate('yue', ['en', 'zh-Hant'])).toBe('zh-Hant')
    expect(closestCandidate('es', ['ja', 'zh-Hans'])).toBe('ja')
  })
})

describe('looksLikeTransliteratedLatin', () => {
  it('flags English heard as Japanese (mostly katakana)', () => {
    expect(looksLikeTransliteratedLatin('マスケセンクレタアピジャウダリーシニター。')).toBe(true)
    expect(looksLikeTransliteratedLatin('ハロー、ハウアーユー')).toBe(true)
  })
  it('keeps ordinary Japanese', () => {
    expect(looksLikeTransliteratedLatin('すみません駅はここから遠いですか？')).toBe(false)
    expect(looksLikeTransliteratedLatin('袋お願いします。')).toBe(false)
    expect(looksLikeTransliteratedLatin('コンビニで温めますか？')).toBe(false)
  })
  it('ignores very short text', () => {
    expect(looksLikeTransliteratedLatin('ハイ')).toBe(false)
  })
})

describe('vadToSamples', () => {
  // whisper.cpp's VAD reports segment times in centiseconds; treating them as seconds put
  // speech starts far past the captured audio, which trimmed or dropped whole pieces.
  it('converts centiseconds to 16 kHz samples', () => {
    expect(vadToSamples(100)).toBe(16000)
    expect(vadToSamples(25)).toBe(4000)
    expect(vadToSamples(0)).toBe(0)
  })
})

describe('languageFromScript', () => {
  const enJa = ['en', 'ja'] as const
  it('moves Japanese text labelled English to Japanese', () => {
    expect(languageFromScript('三千円です。', 'en', [...enJa])).toBe('ja')
  })
  it('moves English text labelled Japanese to English', () => {
    expect(languageFromScript('Thank you.', 'ja', [...enJa])).toBe('en')
  })
  it('keeps correct labels', () => {
    expect(languageFromScript('How much is this bag?', 'en', [...enJa])).toBeNull()
    expect(languageFromScript('どういたしまして。', 'ja', [...enJa])).toBeNull()
    expect(languageFromScript('I love 大阪 food', 'en', [...enJa])).toBeNull()
  })
  it('sends Han-only text to Chinese, and kana to Japanese, when both are possible', () => {
    expect(languageFromScript('你好，请问地铁站在哪里？', 'en', ['en', 'zh-Hans'])).toBe('zh-Hans')
    expect(languageFromScript('はい、そうです', 'zh-Hans', ['zh-Hans', 'ja'])).toBe('ja')
  })
  it('leaves kanji-only text alone between Japanese and Chinese', () => {
    expect(languageFromScript('三千円', 'ja', ['ja', 'zh-Hans'])).toBeNull()
  })
  it('does nothing without a matching language in the pair', () => {
    expect(languageFromScript('三千円です。', 'en', ['en', 'ms'])).toBeNull()
    expect(languageFromScript('ok', 'en', [...enJa])).toBeNull()
  })
})

describe('isMostlyLatin', () => {
  it('tells Latin text from katakana', () => {
    expect(isMostlyLatin('Oh nice, I love Osaka.')).toBe(true)
    expect(isMostlyLatin('オーナイスアイラブ大阪')).toBe(false)
    expect(isMostlyLatin('...')).toBe(true)
  })
})

describe('hasMangledJapaneseNumber', () => {
  it('spots half-converted numbers from SenseVoice', () => {
    expect(hasMangledJapaneseNumber('三00円です。')).toBe(true)
    expect(hasMangledJapaneseNumber('二五0百円になります。')).toBe(true)
    expect(hasMangledJapaneseNumber('お部屋は三5号室です。')).toBe(true)
  })
  it('accepts normal Japanese numbers', () => {
    expect(hasMangledJapaneseNumber('3000円です。')).toBe(false)
    expect(hasMangledJapaneseNumber('三千円です。')).toBe(false)
    expect(hasMangledJapaneseNumber('1万円です。')).toBe(false)
    expect(hasMangledJapaneseNumber('電車は10時15分に出ます。')).toBe(false)
    expect(hasMangledJapaneseNumber('一番好きです。')).toBe(false)
  })
})
