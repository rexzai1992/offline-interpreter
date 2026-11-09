import * as Speech from 'expo-speech'
import { Platform } from 'react-native'
import { LANGUAGES, LANGUAGE_LIST, type LanguageCode } from '../languages'

export interface VoiceInfo {
  identifier: string
  name: string
  language: string
  quality: string
  /**
   * Whether the voice is known to work offline. expo-speech does not expose
   * Android's isNetworkConnectionRequired/notInstalled flags, so this is a
   * heuristic: Google's engine names installed offline voices "...-local",
   * network voices "...-network", and uses "<lang>-language" as a placeholder
   * that may download data or use the network on first use. iOS voices are
   * always on-device.
   */
  offline: 'yes' | 'unknown' | 'no'
}

export type VoiceSupport = Record<LanguageCode, VoiceInfo | null>

/**
 * Per-utterance budget: how long we wait for the engine's done/stopped/error
 * callback before giving up on it. Android's TextToSpeech can stay silent
 * forever (voice data not installed, engine error, utterance flushed after
 * stop(), ...), which would otherwise leave `waitIdle()` hanging.
 * Real speech is ~60-70 ms/char for Latin scripts and ~130-300 ms/char for
 * CJK at rate 1.0, so these budgets are roughly 1.5-2x generous.
 */
const MS_PER_CHAR_LATIN = 150
const MS_PER_CHAR_CJK = 400
const UTTERANCE_BASE_MS = 2000
const UTTERANCE_MAX_MS = 30000
/** How long to wait for the platform to enumerate voices before reporting none. */
const VOICE_LIST_TIMEOUT_MS = 8000
/**
 * Android's TextToSpeech.getMaxSpeechInputLength() is 4000 chars; expo-speech
 * throws (asynchronously, with no callback) above that. Chunks are also kept
 * short enough that their budget fits under UTTERANCE_MAX_MS.
 */
const MAX_CHUNK_CHARS = Math.min(3500, Number.isFinite(Speech.maxSpeechInputLength) ? Speech.maxSpeechInputLength - 1 : 3500)

const CJK_RE = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/

/** Milliseconds we are willing to wait for the engine to finish `text`. */
export function utteranceBudgetMs(text: string): number {
  let ms = UTTERANCE_BASE_MS
  for (const ch of text) ms += CJK_RE.test(ch) ? MS_PER_CHAR_CJK : MS_PER_CHAR_LATIN
  return Math.min(UTTERANCE_MAX_MS, ms)
}

/**
 * Split text into pieces the engine can take in one utterance: below the
 * Android input limit and short enough that the per-utterance budget is not
 * capped. Splits at sentence ends, then whitespace/commas, then hard.
 */
export function chunkForSpeech(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest) {
    if (rest.length <= maxChars && budgetUncapped(rest)) {
      out.push(rest)
      break
    }
    // Largest prefix whose budget is not capped.
    let limit = Math.min(rest.length, maxChars)
    while (limit > 1 && !budgetUncapped(rest.slice(0, limit))) limit = Math.floor(limit * 0.8)
    const head = rest.slice(0, limit)
    let cut = -1
    for (const re of [/[.!?。！？…]["”」』）)]*\s*/g, /[,，、;；:：]\s*/g, /\s+/g]) {
      let m: RegExpExecArray | null
      while ((m = re.exec(head)) !== null) {
        const end = m.index + m[0].length
        if (end >= head.length) break
        if (end >= limit * 0.25) cut = end
      }
      if (cut > 0) break
    }
    if (cut <= 0) cut = limit
    const piece = rest.slice(0, cut).trim()
    if (piece) out.push(piece)
    rest = rest.slice(cut).trim()
  }
  return out
}

function budgetUncapped(s: string): boolean {
  let ms = UTTERANCE_BASE_MS
  for (const ch of s) {
    ms += CJK_RE.test(ch) ? MS_PER_CHAR_CJK : MS_PER_CHAR_LATIN
    if (ms >= UTTERANCE_MAX_MS) return false
  }
  return true
}

interface Utterance {
  id: number
  text: string
  budget: number
  deadline: number
  started: boolean
  timer: ReturnType<typeof setTimeout> | null
  finish: () => void
}

/**
 * Speech output through the platform speech engine (AVSpeechSynthesizer on
 * iOS, android.speech.tts on Android). Whether a language has a voice, and
 * whether that voice works offline, depends on the device:
 *  - iOS voices are always on-device; Apple ships no Filipino voice.
 *  - Android depends on the installed TTS engine (usually Google's), which
 *    needs the language's voice data downloaded for offline use.
 * This module only reports what the device actually enumerates.
 *
 * Latency notes (from the speed research):
 *  - Both platforms queue utterances, so sentences are enqueued as soon as the
 *    translator produces them and play back-to-back.
 *  - The first utterance per language pays engine/voice start-up (0.5-2 s), so
 *    `prewarm()` speaks a silent phrase per selected language at launch.
 *  - On iOS `useApplicationAudioSession` keeps the app's single audio session
 *    (play-and-record) instead of reconfiguring the route per utterance.
 *
 * Robustness: every utterance carries a deadline (chained behind the
 * utterances queued ahead of it, restarted when the engine reports onStart).
 * When the deadline passes without a callback the utterance is treated as
 * finished so `speak()`/`waitIdle()` always resolve; if it never even started
 * the engine is assumed stuck and flushed.
 */
class SpeakerImpl {
  private voices: VoiceInfo[] = []
  private support: VoiceSupport | null = null
  private muted = false
  private active: Utterance[] = []
  private seq = 0
  private warmed = new Set<LanguageCode>()
  private listeners = new Set<() => void>()
  private idleResolvers: (() => void)[] = []
  private refreshing: Promise<VoiceSupport> | null = null

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private emit() {
    for (const l of this.listeners) {
      try {
        l()
      } catch (e) {
        console.warn('Speaker: listener failed', e)
      }
    }
  }

  isMuted(): boolean {
    return this.muted
  }

  setMuted(m: boolean) {
    this.muted = m
    if (m) void this.stop()
    this.emit()
  }

  isSpeaking(): boolean {
    return this.active.length > 0
  }

  async refreshVoices(): Promise<VoiceSupport> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefreshVoices().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefreshVoices(): Promise<VoiceSupport> {
    // Android's getVoices waits for the TTS engine to initialise, which can take
    // a while (or never happen). Report what we have after a timeout and apply
    // the real list if it arrives later.
    const listing = Speech.getAvailableVoicesAsync()
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), VOICE_LIST_TIMEOUT_MS)
    })
    try {
      const vs = await Promise.race([listing, timeout])
      if (vs === 'timeout') {
        console.warn('Speaker: voice listing timed out; will apply it when it arrives')
        this.applyVoices([])
        listing.then((late) => this.applyVoices(late)).catch(() => undefined)
      } else {
        this.applyVoices(vs)
      }
    } catch (e) {
      console.warn('Speaker: could not list voices', e)
      this.applyVoices([])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return this.support!
  }

  private applyVoices(vs: Speech.Voice[]) {
    this.voices = vs.map((v) => ({
      identifier: v.identifier,
      name: v.name,
      language: v.language,
      quality: String(v.quality),
      offline: classifyOffline(v.identifier, v.name),
    }))
    const support = {} as VoiceSupport
    for (const def of LANGUAGE_LIST) support[def.code] = this.pickVoice(def.code)
    this.support = support
    this.emit()
  }

  getSupport(): VoiceSupport | null {
    return this.support
  }

  allVoices(): VoiceInfo[] {
    return this.voices
  }

  private pickVoice(code: LanguageCode): VoiceInfo | null {
    return pickVoiceFrom(code, this.voices)
  }

  hasVoice(code: LanguageCode): boolean {
    return !!this.support?.[code]
  }

  /**
   * Speak a silent phrase once per language so the first real sentence starts
   * promptly. Safe to fire-and-forget: every step is bounded by a timeout and
   * nothing here throws.
   */
  async prewarm(codes: LanguageCode[]): Promise<void> {
    try {
      if (!this.support) await this.refreshVoices()
      if (this.muted) return
      const phrase: Record<LanguageCode, string> = {
        en: 'Ready.',
        ms: 'Sedia.',
        ja: '準備完了。',
        'zh-Hans': '准备好了。',
        'zh-Hant': '準備好了。',
        tl: 'Handa na.',
      }
      const jobs: Promise<void>[] = []
      for (const code of codes) {
        if (this.warmed.has(code) || !this.support?.[code]) continue
        this.warmed.add(code)
        jobs.push(this.enqueue(phrase[code], code, 0).catch(() => undefined))
      }
      await Promise.all(jobs)
    } catch (e) {
      console.warn('Speaker: prewarm failed', e)
    }
  }

  /**
   * Enqueue text in the given language. Resolves when this utterance has
   * finished (or immediately if muted / no voice). Utterances play in order.
   * Always resolves, even if the engine never reports completion.
   */
  speak(text: string, code: LanguageCode): Promise<void> {
    if (this.muted || !text.trim()) return Promise.resolve()
    return this.enqueue(text, code, 1)
  }

  /** Resolves once everything queued so far has finished playing. */
  waitIdle(): Promise<void> {
    if (this.active.length === 0) return Promise.resolve()
    return new Promise((r) => this.idleResolvers.push(r))
  }

  private enqueue(text: string, code: LanguageCode, volume: number): Promise<void> {
    const voice = this.support?.[code]
    if (!voice) return Promise.resolve()
    const chunks = chunkForSpeech(text)
    if (chunks.length === 0) return Promise.resolve()
    // Enqueue all chunks at once so they play back-to-back; the engine queue is FIFO.
    return Promise.all(chunks.map((c) => this.speakOne(c, voice, code, volume))).then(() => undefined)
  }

  private speakOne(text: string, voice: VoiceInfo, code: LanguageCode, volume: number): Promise<void> {
    const def = LANGUAGES[code]
    return new Promise((resolve) => {
      const budget = utteranceBudgetMs(text)
      const u: Utterance = { id: ++this.seq, text, budget, deadline: 0, started: false, timer: null, finish: () => undefined }
      u.finish = () => {
        if (u.timer) clearTimeout(u.timer)
        u.timer = null
        const i = this.active.indexOf(u)
        if (i < 0) return // already finished (late or duplicate callback)
        this.active.splice(i, 1)
        if (this.active.length === 0) {
          const rs = this.idleResolvers
          this.idleResolvers = []
          rs.forEach((r) => r())
        }
        this.emit()
        resolve()
      }
      // The deadline is chained behind whatever is queued ahead, so an utterance
      // waiting its turn is not timed out prematurely.
      const prev = this.active[this.active.length - 1]
      u.deadline = Math.max(Date.now(), prev?.deadline ?? 0) + budget
      this.active.push(u)
      this.emit()
      this.arm(u)
      try {
        Speech.speak(text, {
          language: ttsLanguage(voice, def.tts[0]),
          voice: Platform.OS === 'web' ? undefined : voice.identifier,
          rate: 1.0,
          pitch: 1.0,
          // Honoured on all platforms (Android: KEY_PARAM_VOLUME).
          volume,
          // iOS only; the Android options record has no such field and ignores it.
          ...(Platform.OS === 'ios' ? { useApplicationAudioSession: true } : {}),
          onStart: () => {
            u.started = true
            u.deadline = Date.now() + budget
            this.arm(u)
          },
          onDone: u.finish,
          onStopped: u.finish,
          onError: (e) => {
            console.warn(`Speaker: engine error for ${code}`, e?.message ?? e)
            u.finish()
          },
        })
      } catch (e) {
        console.warn('Speaker: speak failed', e)
        u.finish()
      }
    })
  }

  private arm(u: Utterance) {
    if (u.timer) clearTimeout(u.timer)
    const wait = Math.max(0, u.deadline - Date.now())
    u.timer = setTimeout(() => {
      u.timer = null
      if (this.active.indexOf(u) < 0) return
      if (u.started) {
        // Playing but no completion callback: assume it ended and move on.
        console.warn(`Speaker: no completion callback within ${Math.round(u.budget / 1000)}s, giving up on utterance`)
        u.finish()
      } else {
        // Never started: the engine is stuck (missing voice data, init failure,
        // flushed queue). Flush it so later utterances do not pile up behind.
        console.warn('Speaker: utterance never started, flushing the engine')
        void this.stop()
      }
    }, wait)
  }

  /** Interrupt playback, drop the queue and resolve every pending `speak()`. */
  async stop(): Promise<void> {
    // Settle our side first, then flush the engine in the same tick so a
    // continuation that enqueues new speech is not flushed with the old queue.
    for (const u of [...this.active]) u.finish()
    let p: Promise<void> | undefined
    try {
      p = Speech.stop()
    } catch {
      /* ignore */
    }
    try {
      await p
    } catch {
      /* ignore */
    }
  }
}

/**
 * The `language` option: iOS/web take a BCP-47 tag. expo-speech on Android
 * builds the locale with Locale.Builder().setLanguage(), which throws on a
 * region tag ("ja-JP") and then silently falls back to the device locale, so
 * only the primary subtag is passed there (the voice sets the exact locale).
 */
function ttsLanguage(voice: VoiceInfo, fallback: string): string {
  const tag = voice.language || fallback
  if (Platform.OS === 'android') return tag.split(/[-_]/)[0] || tag
  return tag
}

interface Tag {
  full: string
  lang: string
  script: 'hans' | 'hant' | null
  region: string | null
}

function parseTag(raw: string): Tag {
  const full = raw.replace(/_/g, '-').toLowerCase()
  const parts = full.split('-').filter(Boolean)
  const lang = parts[0] ?? ''
  let script: Tag['script'] = null
  let region: string | null = null
  for (const p of parts.slice(1)) {
    if (p === 'hans' || p === 'hant') script = p
    else if (!region && /^([a-z]{2}|\d{3})$/.test(p)) region = p
  }
  return { full, lang, script, region }
}

const MANDARIN = new Set(['zh', 'cmn'])
const CHINESE = new Set(['zh', 'cmn', 'yue'])
const SIMPLIFIED_REGIONS = new Set(['cn', 'sg'])

const isSimplifiedMandarin = (t: Tag) => MANDARIN.has(t.lang) && (t.script === 'hans' || (t.script === null && !!t.region && SIMPLIFIED_REGIONS.has(t.region)))
// Only Taiwan: zh-HK and zh-MO voices speak Cantonese, not Mandarin.
const isTraditionalMandarin = (t: Tag) => MANDARIN.has(t.lang) && (t.script === 'hant' || (t.script === null && t.region === 'tw'))
const isHongKongMacau = (t: Tag) => CHINESE.has(t.lang) && t.script !== 'hans' && (t.region === 'hk' || t.region === 'mo')
const isBareMandarin = (t: Tag) => MANDARIN.has(t.lang) && t.script === null && t.region === null
const isAnyChinese = (t: Tag) => CHINESE.has(t.lang)

/**
 * Choose the best voice for a language from an enumerated list.
 *  - Non-Chinese languages: the BCP-47 tags in `LANGUAGES[code].tts` in order,
 *    then any voice with the same primary language (Filipino accepts fil/tl).
 *  - Chinese: script-aware tiers so Traditional never gets a zh-CN voice and
 *    Simplified never gets a zh-TW/zh-HK voice unless nothing else exists.
 *    Android (Google) reports "cmn-CN"/"cmn-TW"/"yue-HK"; iOS "zh-CN"/"zh-TW"/"zh-HK".
 */
export function pickVoiceFrom(code: LanguageCode, voices: VoiceInfo[]): VoiceInfo | null {
  const def = LANGUAGES[code]
  const tagged = voices.map((v) => ({ v, tag: parseTag(v.language) }))
  const best = (pred: (t: Tag) => boolean): VoiceInfo | null => {
    const c = tagged.filter((p) => pred(p.tag)).map((p) => p.v)
    return c.length ? c.slice().sort(byQuality)[0] : null
  }
  if (code === 'zh-Hans') {
    return best(isSimplifiedMandarin) ?? best(isBareMandarin) ?? best(isTraditionalMandarin) ?? best(isHongKongMacau) ?? best(isAnyChinese)
  }
  if (code === 'zh-Hant') {
    return best(isTraditionalMandarin) ?? best(isHongKongMacau) ?? best(isBareMandarin) ?? best(isSimplifiedMandarin) ?? best(isAnyChinese)
  }
  for (const tag of def.tts) {
    const t = parseTag(tag).full
    const r = best((x) => x.full === t)
    if (r) return r
  }
  const primaries = new Set(def.tts.map((t) => parseTag(t).lang))
  if (code === 'tl') {
    primaries.add('fil')
    primaries.add('tl')
  }
  return best((t) => primaries.has(t.lang))
}

function classifyOffline(identifier: string, name: string): VoiceInfo['offline'] {
  if (Platform.OS === 'ios') return 'yes'
  const id = `${identifier} ${name}`.toLowerCase()
  if (/-local\b/.test(id)) return 'yes'
  if (/-network\b/.test(id)) return 'no'
  return 'unknown'
}

/** Prefer confirmed-offline voices, then enhanced quality. */
function byQuality(a: VoiceInfo, b: VoiceInfo): number {
  const o = (v: VoiceInfo) => (v.offline === 'yes' ? 0 : v.offline === 'unknown' ? 1 : 2)
  if (o(a) !== o(b)) return o(a) - o(b)
  const q = (v: VoiceInfo) => (/enhanced|premium/i.test(v.quality) ? 0 : 1)
  return q(a) - q(b)
}

export const Speaker = new SpeakerImpl()
