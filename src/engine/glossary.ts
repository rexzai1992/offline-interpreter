import { LANGUAGES, type LanguageCode } from '../languages'

/**
 * The user's names and special words (Setup > Names and special words). Recognisers
 * mishear names they have never seen ("Takeshi" as "Taka she"); the list is used to
 * nudge Whisper's spelling, to repair near-misses in recognised text, and to tell the
 * translator to keep names as written.
 */
export interface NameEntry {
  term: string
  /** How to write it in the other language, if given as "term = rendering". */
  rendering?: string
}

/** One entry per line (or comma); "Takeshi = タケシ" also fixes the translation. */
export function parseNames(raw: string): NameEntry[] {
  const out: NameEntry[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/[\n,，、]+/)) {
    const [left, ...rest] = line.split('=')
    const term = left.trim().replace(/\s+/g, ' ')
    if (!term || term.length > 60) continue
    const rendering = rest.join('=').trim() || undefined
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rendering ? { term, rendering } : { term })
    if (out.length >= 50) break
  }
  return out
}

/** Whisper initial-prompt fragment that biases its spelling towards the listed names. */
export function whisperNameHint(entries: NameEntry[]): string {
  if (entries.length === 0) return ''
  return `${entries.map((e) => e.term).join(', ')}.`.slice(0, 220)
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-zÀ-ɏ]/g, '')

/** Consonant skeleton: survives the vowel and spacing mistakes recognisers make on names. */
function skeleton(s: string): string {
  const k = letters(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ph/g, 'f')
    .replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/v/g, 'b')
    .replace(/[aeiouyhw]/g, '')
  return k.replace(/(.)\1+/g, '$1')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

const similarity = (a: string, b: string) => (a.length || b.length ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 1)

/**
 * Replace near-misses of listed Latin-script names in recognised text. Conservative on
 * purpose: a single ordinary word ("takes") is only replaced by a short name when it is
 * nearly identical; a name split into pieces ("Taka she") or a long name with the same
 * consonants ("I had been a smile" for "Ahmad bin Ismail") is repaired.
 */
export function correctNames(text: string, entries: NameEntry[]): string {
  let out = text
  for (const { term } of entries) {
    const termLetters = letters(term)
    if (termLetters.length < 4 || /[^\x20-ɏ]/.test(term)) continue
    const termSkel = skeleton(term)
    const words = [...out.matchAll(/[A-Za-zÀ-ɏ']+/g)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    const termWords = term.split(' ').length
    let best: { start: number; end: number; score: number } | null = null
    for (let w = Math.max(1, termWords - 1); w <= termWords + 3; w++) {
      for (let i = 0; i + w <= words.length; i++) {
        const span = out.slice(words[i].start, words[i + w - 1].end)
        const spanLetters = letters(span)
        if (spanLetters.length < 3) continue
        if (spanLetters === termLetters) {
          if (span !== term && (!best || best.score < 2)) best = { start: words[i].start, end: words[i + w - 1].end, score: 2 }
          continue
        }
        const simL = similarity(spanLetters, termLetters)
        const simS = similarity(skeleton(span), termSkel)
        const longName = termSkel.length >= 5
        const split = w > 1
        const ok = simS >= 0.85 && (simL >= 0.85 || (split && simL >= 0.6) || (longName && simL >= 0.45))
        // Prefer the span whose length matches the name ("I had been a smile" over "had been a smile").
        const score = (simS + simL) / 2 - (0.5 * Math.abs(spanLetters.length - termLetters.length)) / termLetters.length
        if (ok && (!best || score > best.score)) best = { start: words[i].start, end: words[i + w - 1].end, score }
      }
    }
    if (best) out = out.slice(0, best.start) + term + out.slice(best.end)
  }
  return out
}

/**
 * Translator references for listed names that occur in the text: the given rendering, or
 * the name unchanged when the target is written in Latin letters. For Japanese or Chinese
 * targets without a rendering the model's own transliteration is kept.
 */
export function nameReferences(text: string, entries: NameEntry[], target: LanguageCode): string[] {
  const lower = text.toLowerCase()
  const latinTarget = !['ja', 'zh'].includes(LANGUAGES[target].whisper)
  const out: string[] = []
  for (const e of entries) {
    if (!lower.includes(e.term.toLowerCase())) continue
    if (e.rendering) out.push(`${e.term} translates to ${e.rendering}`)
    else if (latinTarget) out.push(`${e.term} translates to ${e.term}`)
  }
  return out
}
