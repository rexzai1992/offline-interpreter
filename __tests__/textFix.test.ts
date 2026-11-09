import { describe, expect, it } from '@jest/globals'
import { addQuestionMarks, chineseDialect, echoesEarlierTurn, fixSpokenTimes, roughAgreement, textSimilarity, tidyCjkSpacing } from '../src/engine/textFix'

describe('tidyCjkSpacing', () => {
  it('removes spaces between Japanese characters', () => {
    expect(tidyCjkSpacing('駅の 近 くに 美味しいラーメン 屋 さん があり ます よ。')).toBe('駅の近くに美味しいラーメン屋さんがありますよ。')
    expect(tidyCjkSpacing('現金の方が早い です。')).toBe('現金の方が早いです。')
  })
  it('keeps spaces next to Latin words and leaves Latin text alone', () => {
    expect(tidyCjkSpacing('大阪 Station に行きます')).toBe('大阪 Station に行きます')
    expect(tidyCjkSpacing('How much is this bag?')).toBe('How much is this bag?')
  })
})

describe('addQuestionMarks', () => {
  const q = (s: string) => addQuestionMarks(s, 'en')
  it('turns spoken English questions into questions', () => {
    expect(q('How much is this bag.')).toBe('How much is this bag?')
    expect(q('Excuse me. Where is the bathroom.')).toBe('Excuse me. Where is the bathroom?')
    expect(q('Do you know if it is open after 10 PM.')).toBe('Do you know if it is open after 10 PM?')
    expect(q('Can I pay by credit card there.')).toBe('Can I pay by credit card there?')
    expect(q('Is this seat taken.')).toBe('Is this seat taken?')
    expect(q("The weather has been lovely all week, hasn't it.")).toBe("The weather has been lovely all week, hasn't it?")
    expect(q('What time does the bus leave.')).toBe('What time does the bus leave?')
    expect(q('Hello, can you hear me clearly.')).toBe('Hello, can you hear me clearly?')
    expect(q('Excuse me, where is the station.')).toBe('Excuse me, where is the station?')
  })
  it('leaves statements alone', () => {
    expect(q('Have a nice day.')).toBe('Have a nice day.')
    expect(q('When I arrived, it was closed.')).toBe('When I arrived, it was closed.')
    expect(q('What a nice day.')).toBe('What a nice day.')
    expect(q('What I mean is the other one.')).toBe('What I mean is the other one.')
    expect(q('Thank you.')).toBe('Thank you.')
    expect(q('Hello, my name is Ravi.')).toBe('Hello, my name is Ravi.')
    expect(q('Take bus number 10. It takes about 20 minutes.')).toBe('Take bus number 10. It takes about 20 minutes.')
  })
  it('handles Mandarin question particles and leaves Japanese alone', () => {
    expect(addQuestionMarks('你好，请问附近有地铁站吗。', 'zh-Hans')).toBe('你好，请问附近有地铁站吗？')
    expect(addQuestionMarks('我知道了。', 'zh-Hans')).toBe('我知道了。')
    expect(addQuestionMarks('これはいくらですか。', 'ja')).toBe('これはいくらですか。')
  })
})

describe('textSimilarity', () => {
  it('is high for near copies and low for unrelated text', () => {
    expect(textSimilarity('Could you tell me how to get to the nearest subway station?', 'Could you tell me how to get to the nearest underground station?')).toBeGreaterThan(0.8)
    expect(textSimilarity('Is that the place where kids play?', 'How much is this bag?')).toBeLessThan(0.3)
    expect(textSimilarity('駅の近くにラーメン屋があります', '駅の近くにラーメン屋さんがありますよ')).toBeGreaterThan(0.7)
  })
})

describe('echoesEarlierTurn', () => {
  const history = [
    { original: 'Could you tell me how to get to the nearest underground station?', translation: '一番近い地下鉄の駅への行き方を教えてください。', sourceLanguage: 'en' as const, targetLanguage: 'ja' as const },
    { original: 'Thank you.', translation: 'ありがとう。', sourceLanguage: 'en' as const, targetLanguage: 'ja' as const },
  ]
  it('flags a translation that copies an earlier message', () => {
    expect(echoesEarlierTurn('Hey, could you tell me how to get to the nearest subway station?', { text: '親ラ場イはテちと防ザや語トバす。', language: 'ja' }, 'en', history)).toBe(true)
  })
  it('does not judge short phrases', () => {
    const greet = [{ original: 'How are you?', translation: '你好吗？', sourceLanguage: 'en' as const, targetLanguage: 'zh-Hans' as const }]
    expect(echoesEarlierTurn('How are you?', { text: '你好呀', language: 'zh-Hans' }, 'en', greet)).toBe(false)
  })
  it('does not flag a real repeat or an unrelated translation', () => {
    expect(echoesEarlierTurn('Thank you.', { text: 'ありがとう。', language: 'ja' }, 'en', history)).toBe(false)
    expect(echoesEarlierTurn('It is 3000 yen.', { text: '3000円です。', language: 'ja' }, 'en', history)).toBe(false)
  })
})

describe('fixSpokenTimes', () => {
  const f = (s: string) => fixSpokenTimes(s, 'en')
  it('rewrites clock times written as numbers', () => {
    expect(f('My flight is at 7,45 tomorrow morning from gate 23.')).toBe('My flight is at 7:45 tomorrow morning from gate 23.')
    expect(f('I will call him at930.')).toBe('I will call him at 9:30.')
    expect(f('See you at 1045 tomorrow.')).toBe('See you at 10:45 tomorrow.')
    expect(f('Open until 930 pm.')).toBe('Open until 9:30 pm.')
  })
  it('leaves other numbers alone', () => {
    expect(f('It costs 1,000 yen.')).toBe('It costs 1,000 yen.')
    expect(f('Around 2000 people came.')).toBe('Around 2000 people came.')
    expect(f('Gate 23, please.')).toBe('Gate 23, please.')
    expect(f('Room 1205 is on the left.')).toBe('Room 1205 is on the left.')
    expect(fixSpokenTimes('7,45', 'ja')).toBe('7,45')
  })
})

describe('chineseDialect', () => {
  it('spots Hokkien and Cantonese written by the recogniser', () => {
    expect(chineseDialect('阮毋喜欢汝。', 'zh-Hans')).toBe('Hokkien')
    expect(chineseDialect('阮叨是阮男妈的话。', 'zh-Hans')).toBe('Hokkien')
    expect(chineseDialect('喂你食唔系利事啊。', 'zh-Hans')).toBe('Cantonese')
  })
  it('leaves Mandarin alone, including the surname 阮', () => {
    expect(chineseDialect('我们一起去喝咖啡吧。', 'zh-Hans')).toBeNull()
    expect(chineseDialect('阮先生明天来。', 'zh-Hans')).toBeNull()
    expect(chineseDialect('你毋须担心。', 'zh-Hans')).toBeNull()
    expect(chineseDialect('我毋须担心', 'en')).toBeNull()
  })
})

describe('roughAgreement', () => {
  it('is high for the same sentence and zero across languages', () => {
    expect(roughAgreement('Excuse me. Is this seat taken.', 'Excuse me, is this seat taken?')).toBe(1)
    expect(roughAgreement('我也是马来西亚人，我住在吉隆坡。', '我也是马来西亚人,我住在吉隆坡。')).toBe(1)
    expect(roughAgreement('セラマパギアパハバ。', 'Selamat pagi, Aba Haba')).toBe(0)
    expect(roughAgreement('思安黛娘。', 'Selamat datang')).toBe(0)
  })
})
