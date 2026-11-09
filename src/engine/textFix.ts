import type { LanguageCode } from '../languages'

/**
 * Small, deterministic clean-ups of recognised text and checks on translations. Pure
 * functions, so they are unit-tested without a phone.
 */

const CJK_CHAR = /[　-〿぀-ヿ㐀-鿿豈-﫿＀-￯]/

/**
 * SenseVoice sometimes puts spaces between Japanese or Chinese words ("駅の 近 くに").
 * Remove a space when the characters on both sides are CJK; spaces next to Latin words
 * ("大阪 Station") stay.
 */
export function tidyCjkSpacing(text: string): string {
  if (!CJK_CHAR.test(text)) return text
  let out = ''
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (/\s/.test(ch)) {
      let j = i
      while (j < chars.length && /\s/.test(chars[j])) j++
      const before = out.slice(-1)
      const after = chars[j] ?? ''
      if (before && after && CJK_CHAR.test(before) && CJK_CHAR.test(after)) {
        i = j - 1
        continue
      }
    }
    out += ch
  }
  return out
}

const EN_AUX = new Set([
  'is', 'are', 'am', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'would', 'will', 'shall', 'should', 'may', 'might', 'have', 'has', 'had',
  "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't", "didn't", "can't", "couldn't", "wouldn't", "won't", "shouldn't", "haven't", "hasn't",
])
const EN_SUBJECT = new Set([
  'you', 'i', 'we', 'they', 'he', 'she', 'it', 'this', 'that', 'there', 'these', 'those', 'the', 'a', 'an', 'my', 'your', 'our', 'his', 'her', 'their',
  'anyone', 'anybody', 'someone', 'somebody', 'everyone', 'everything', 'anything', 'something', 'any', 'some',
])
const EN_PRONOUN = new Set(['i', 'you', 'we', 'they', 'he', 'she', 'it'])

/** Short openers that come before the actual question: "Hello, can you hear me". */
const EN_OPENER = /^(hello|hi|hey|excuse me|sorry|okay|ok|so|and|well|um|uh|oh|hi there|hello there|by the way|actually)\s*,\s*/i

/** Whether an English sentence (without its final punctuation) reads as a question. */
function englishQuestion(sentence: string): boolean {
  const rest = sentence.replace(EN_OPENER, '')
  if (rest !== sentence && rest.length > 0) return englishQuestionCore(rest)
  return englishQuestionCore(sentence)
}

function englishQuestionCore(sentence: string): boolean {
  const words = sentence.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length < 2) return false
  const [w0, w1] = words
  // Tag questions: "..., isn't it", "..., right", "..., don't you".
  if (/,\s*(right|okay|ok|correct)$/i.test(sentence)) return true
  if (/,\s*[a-z]+n't\s+(it|you|we|they|he|she|there|i)$/i.test(sentence)) return true
  // "Have a nice day" and "Do the dishes" are commands: only "have"/"do" + pronoun asks.
  if (w0 === 'have' || w0 === 'do') return EN_PRONOUN.has(w1)
  if (EN_AUX.has(w0)) return EN_SUBJECT.has(w1)
  if (w0 === 'who' || w0 === 'whom') return true
  if (w0 === 'how' || w0 === 'what') return (w1 === 'about' || EN_AUX.has(w1) || !EN_PRONOUN.has(w1)) && w1 !== 'a' && w1 !== 'an'
  if (w0 === 'which' || w0 === 'whose') return !EN_PRONOUN.has(w1)
  if (w0 === 'where' || w0 === 'when' || w0 === 'why') return EN_AUX.has(w1)
  return false
}

/**
 * Recognisers usually end spoken questions with a full stop ("How much is this bag.").
 * Restore the question mark where the wording makes the question unambiguous: English
 * questions that start with an auxiliary + subject or a question word, tag questions,
 * and Mandarin sentences ending in 吗/嗎/呢. Japanese か。 is standard written style and
 * is left alone.
 */
export function addQuestionMarks(text: string, language: LanguageCode): string {
  if (language === 'en') {
    return text.replace(/([^.!?]+)\.(?=\s|$)/g, (m, body: string) => (englishQuestion(body.trim()) ? `${body}?` : m))
  }
  if (language === 'zh-Hans' || language === 'zh-Hant') {
    return text.replace(/([吗嗎呢])[。.]/g, '$1？').replace(/([吗嗎呢])$/, '$1？')
  }
  return text
}

/** Word tokens for Latin text, character bigrams for CJK runs (lower-cased, no punctuation). */
function tokens(text: string): string[] {
  const out: string[] = []
  for (const run of text.toLowerCase().match(/[a-z0-9À-ɏ']+|[぀-ヿ㐀-鿿豈-﫿]+/g) ?? []) {
    if (/^[a-z0-9À-ɏ']+$/.test(run)) out.push(run)
    else {
      const chars = Array.from(run)
      if (chars.length === 1) out.push(run)
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
    }
  }
  return out
}

/** Dice similarity of two texts' token sets, from 0 (nothing shared) to 1 (same tokens). */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return (2 * shared) / (ta.size + tb.size)
}

export interface EchoTurn {
  original: string
  translation: string
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
}

/**
 * Whether a fresh translation is a copy of something already said, rather than a
 * translation of the new text. When recognition produces nonsense, the translation model
 * fills the gap from the conversation it was given as context and returns a fluent but
 * unrelated sentence (seen in speaker tests). A real repeat ("Thank you" twice) is not an
 * echo: then the new source text also resembles the earlier message's source text.
 */
export function echoesEarlierTurn(
  translation: string,
  source: { text: string; language: LanguageCode },
  target: LanguageCode,
  history: EchoTurn[],
  threshold = 0.6,
): boolean {
  // Short phrases ("Thank you", "你好吗") are legitimately said again and again; only judge
  // sentences long enough for a copied translation to be telling.
  if (tokens(translation).length < 4 || tokens(source.text).length < 4) return false
  for (const t of history.slice(-8)) {
    const inTarget = t.sourceLanguage === target ? t.original : t.targetLanguage === target ? t.translation : ''
    if (!inTarget || textSimilarity(translation, inTarget) < threshold) continue
    const inSource = t.sourceLanguage === source.language ? t.original : t.targetLanguage === source.language ? t.translation : ''
    if (inSource && textSimilarity(source.text, inSource) >= 0.4) continue
    return true
  }
  return false
}

const TIME_PREP = '(at|by|around|until|till|before|after|from|to)'
const TIME_FOLLOW = String.raw`(?=\s*(?:$|[.,!?;:]|a\.?m\.?\b|p\.?m\.?\b|am\b|pm\b|o'clock\b|tomorrow\b|today\b|tonight\b|in\b|on\b|this\b|next\b|and\b|or\b))`

/**
 * English clock times as SenseVoice's number formatting writes them: "seven forty five"
 * becomes "7,45" and "at nine thirty" becomes "at930". Rewritten to "7:45" and "at 9:30"
 * only when the hour and minutes are plausible and the words around them mark a time,
 * so "1,000" or "around 2000 people" are left alone.
 */
export function fixSpokenTimes(text: string, language: LanguageCode): string {
  if (language !== 'en') return text
  const plausible = (h: string, m: string) => Number(h) >= 0 && Number(h) <= 23 && Number(m) <= 59
  return text
    .replace(new RegExp(`\\b${TIME_PREP}(\\d)`, 'gi'), '$1 $2')
    .replace(/\b(\d{1,2}),(\d{2})\b(?![,.]?\d)/g, (m, h: string, min: string) => (plausible(h, min) ? `${h}:${min}` : m))
    .replace(new RegExp(`\\b${TIME_PREP} (\\d{1,2})(\\d{2})\\b${TIME_FOLLOW}`, 'gi'), (m, p: string, h: string, min: string) =>
      Number(h) >= 1 && Number(h) <= 12 && Number(min) <= 59 ? `${p} ${h}:${min}` : m,
    )
}

/** Hokkien (Minnan) words SenseVoice writes when it hears Hokkien: 毋 "not", 汝 "you", 恁 "you (pl.)", 佇 "at", 袂 "cannot", 𪜶 "they". */
// 毋须, 毋庸 and 毋宁 are standard written Mandarin and do not count.
const HOKKIEN_STRONG = /毋(?![须須庸宁寧])|[汝恁佇袂𪜶]/
/** Cantonese-only characters: 唔 "not", 嘅, 咗, 佢 "he/she", 冇 "none", 喺 "at", 啲, 嘢 "thing", 咩, 嚟, 嗰, 噉, 揾, 攞. */
const CANTONESE_STRONG = /[唔嘅咗佢冇喺啲嘢咩嚟嗰噉揾攞]/

/**
 * Whether recognised "Mandarin" is really Hokkien or Cantonese, which the app does not
 * understand. 阮 ("I, we" in Hokkien) is also a surname, so it only counts when it
 * appears twice or next to another Hokkien word.
 */
export function chineseDialect(text: string, language: LanguageCode): 'Hokkien' | 'Cantonese' | null {
  if (language !== 'zh-Hans' && language !== 'zh-Hant') return null
  const ruan = (text.match(/阮/g) ?? []).length
  if (HOKKIEN_STRONG.test(text) || ruan >= 2) return 'Hokkien'
  if (CANTONESE_STRONG.test(text)) return 'Cantonese'
  return null
}

/**
 * How much two transcripts of the same audio agree, from 0 to 1: Latin words plus single
 * Chinese/Japanese characters, compared as sets (Dice). Used to compare SenseVoice with
 * Whisper; on correctly heard English and Mandarin they agreed at 0.76 to 1.0 in tests,
 * on Malay that SenseVoice could not understand at 0.
 */
export function roughAgreement(a: string, b: string): number {
  const set = (t: string) => {
    const s = t.normalize('NFKC').toLowerCase()
    return new Set([...(s.match(/[a-z0-9\u00c0-\u024f']+/g) ?? []), ...Array.from(s).filter((c) => /[\u3040-\u30ff\u3400-\u9fff]/.test(c))])
  }
  const A = set(a)
  const B = set(b)
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const x of A) if (B.has(x)) shared++
  return (2 * shared) / (A.size + B.size)
}
