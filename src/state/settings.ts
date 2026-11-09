import AsyncStorage from '@react-native-async-storage/async-storage'
import { LANGUAGES, type LanguageCode } from '../languages'
import { WHISPER_SMALL_Q8, modelById } from '../models/catalog'

export interface Settings {
  langA: LanguageCode
  langB: LanguageCode
  /** Auto-detect which of the two languages was spoken. */
  autoDetect: boolean
  asrModelId: string
  /** Show provisional text while someone is still speaking (costs extra CPU). */
  provisional: boolean
  muted: boolean
  /** Off by default: nothing is persisted unless the user turns this on. */
  saveHistory: boolean
  endSilenceMs: number
  /** Finish a turn early when the provisional text already ends a sentence. */
  semanticEndOfTurn: boolean
  /** Fast mode: keep listening and translate at short pauses (text only, speech output muted). */
  fastMode: boolean
  /** After playback, automatically start listening for the other speaker. */
  autoPingPong: boolean
  /** Voice recognition engine: on-device Whisper, or Groq's hosted Whisper (online, opt-in). */
  asrProvider: AsrProvider
  /** Use the small Whisper base model for English and Mandarin when it is installed. */
  fastAsrForEnZh: boolean
  /** Use SenseVoice for Japanese, English and Mandarin when it is installed. */
  senseVoice: boolean
  /** Names and special words, one per line ("Takeshi = タケシ" also fixes the translation). */
  names: string
}

export type AsrProvider = 'local' | 'groq'

export const DEFAULT_SETTINGS: Settings = {
  langA: 'en',
  langB: 'ja',
  autoDetect: false,
  asrModelId: WHISPER_SMALL_Q8.id,
  provisional: false,
  // Results are shown as text; reading translations aloud is opt-in.
  muted: true,
  saveHistory: false,
  endSilenceMs: 600,
  semanticEndOfTurn: true,
  fastMode: false,
  autoPingPong: false,
  asrProvider: 'local',
  fastAsrForEnZh: true,
  senseVoice: true,
  names: '',
}

/** Bounds used by the Setup screen's +/- buttons. */
export const END_SILENCE_MIN_MS = 400
export const END_SILENCE_MAX_MS = 2000

const KEY = 'interpreter.settings.v2'
/** v1 stored speech output on by default; v2 makes text-only output the default. */
const LEGACY_KEY_V1 = 'interpreter.settings.v1'

function isLanguageCode(v: unknown): v is LanguageCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, v)
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.round(v)))
}

/**
 * Coerce whatever was persisted into a valid `Settings`. Unknown keys are
 * dropped and every invalid value (a language no longer in the table, an ASR
 * model that was removed from the catalog, a non-boolean flag) falls back to
 * its default, so a stale or hand-edited store can never crash the app.
 */
export function sanitizeSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SETTINGS }
  const p = raw as Record<string, unknown>
  const langA = isLanguageCode(p.langA) ? p.langA : DEFAULT_SETTINGS.langA
  const langB = isLanguageCode(p.langB) ? p.langB : DEFAULT_SETTINGS.langB
  const asrCandidate = typeof p.asrModelId === 'string' ? modelById(p.asrModelId) : undefined
  const asrModelId = asrCandidate && asrCandidate.kind === 'asr' ? asrCandidate.id : DEFAULT_SETTINGS.asrModelId
  return {
    langA,
    langB,
    autoDetect: bool(p.autoDetect, DEFAULT_SETTINGS.autoDetect),
    asrModelId,
    provisional: bool(p.provisional, DEFAULT_SETTINGS.provisional),
    muted: bool(p.muted, DEFAULT_SETTINGS.muted),
    saveHistory: bool(p.saveHistory, DEFAULT_SETTINGS.saveHistory),
    endSilenceMs: clampNumber(p.endSilenceMs, DEFAULT_SETTINGS.endSilenceMs, END_SILENCE_MIN_MS, END_SILENCE_MAX_MS),
    semanticEndOfTurn: bool(p.semanticEndOfTurn, DEFAULT_SETTINGS.semanticEndOfTurn),
    fastMode: bool(p.fastMode, DEFAULT_SETTINGS.fastMode),
    autoPingPong: bool(p.autoPingPong, DEFAULT_SETTINGS.autoPingPong),
    asrProvider: p.asrProvider === 'groq' ? 'groq' : 'local',
    fastAsrForEnZh: bool(p.fastAsrForEnZh, DEFAULT_SETTINGS.fastAsrForEnZh),
    senseVoice: bool(p.senseVoice, DEFAULT_SETTINGS.senseVoice),
    names: typeof p.names === 'string' ? p.names.slice(0, 2000) : DEFAULT_SETTINGS.names,
  }
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    if (raw) return sanitizeSettings(JSON.parse(raw))
    const legacy = await AsyncStorage.getItem(LEGACY_KEY_V1)
    if (!legacy) return { ...DEFAULT_SETTINGS }
    // Keep the user's languages and models, switch to text-only output once.
    const migrated = { ...sanitizeSettings(JSON.parse(legacy)), muted: true }
    await AsyncStorage.setItem(KEY, JSON.stringify(migrated))
    await AsyncStorage.removeItem(LEGACY_KEY_V1)
    return migrated
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(sanitizeSettings(s)))
  } catch (e) {
    console.warn('saveSettings failed', e)
  }
}

/**
 * The Groq API key is the user's own and is kept apart from the settings blob so it is
 * never written into saved history or logs. It is stored in this app's private storage.
 */
const GROQ_KEY = 'interpreter.groqApiKey'

export async function loadGroqKey(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(GROQ_KEY)) ?? ''
  } catch {
    return ''
  }
}

export async function saveGroqKey(key: string): Promise<void> {
  try {
    if (key.trim()) await AsyncStorage.setItem(GROQ_KEY, key.trim())
    else await AsyncStorage.removeItem(GROQ_KEY)
  } catch (e) {
    console.warn('saveGroqKey failed', e)
  }
}
