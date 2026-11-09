/**
 * Language definitions for the conversation interpreter.
 *
 * `mtName` is the full language name Hy-MT2 expects in its English prompt
 * template (see the model card: "both source_lang and target_lang should use
 * the full language names").
 *
 * `whisper` is the whisper.cpp language code used for speech recognition.
 * Whisper has a single `zh` code; the output script (Simplified/Traditional)
 * is not guaranteed, so a Traditional-Chinese initial prompt is used to nudge
 * it (see `whisperPrompt`).
 *
 * `tts` is the BCP-47 tag used when asking the platform speech engine for a
 * voice. Availability is checked at runtime (see engine/Speaker.ts); nothing
 * here is a promise that a voice exists on a given device.
 */
export type LanguageCode = 'en' | 'ms' | 'ja' | 'zh-Hans' | 'zh-Hant' | 'tl'

export interface LanguageDef {
  code: LanguageCode
  /** Name shown in the UI */
  label: string
  /** Name in its own language, shown next to the label */
  nativeLabel: string
  /** Full language name used in Hy-MT2 prompts */
  mtName: string
  /** whisper.cpp language code */
  whisper: string
  /** Optional initial prompt to steer whisper's output script */
  whisperPrompt?: string
  /** BCP-47 tags to try for a platform TTS voice, in order of preference */
  tts: string[]
}

export const LANGUAGES: Record<LanguageCode, LanguageDef> = {
  en: {
    code: 'en',
    label: 'English',
    nativeLabel: 'English',
    mtName: 'English',
    whisper: 'en',
    tts: ['en-US', 'en-GB', 'en-AU', 'en-IN', 'en-SG', 'en'],
  },
  ms: {
    code: 'ms',
    label: 'Malay',
    nativeLabel: 'Bahasa Melayu',
    mtName: 'Malay',
    whisper: 'ms',
    tts: ['ms-MY', 'ms'],
  },
  ja: {
    code: 'ja',
    label: 'Japanese',
    nativeLabel: '日本語',
    mtName: 'Japanese',
    whisper: 'ja',
    tts: ['ja-JP', 'ja'],
  },
  'zh-Hans': {
    code: 'zh-Hans',
    label: 'Mandarin (Simplified)',
    nativeLabel: '中文（简体）',
    mtName: 'Chinese',
    whisper: 'zh',
    whisperPrompt: '以下是普通话的句子。',
    tts: ['zh-CN', 'cmn-CN', 'zh-Hans', 'zh'],
  },
  'zh-Hant': {
    code: 'zh-Hant',
    label: 'Mandarin (Traditional)',
    nativeLabel: '中文（繁體）',
    mtName: 'Traditional Chinese',
    whisper: 'zh',
    whisperPrompt: '以下是普通話的句子。',
    tts: ['zh-TW', 'cmn-TW', 'zh-Hant', 'zh-HK', 'zh'],
  },
  tl: {
    code: 'tl',
    label: 'Filipino / Tagalog',
    nativeLabel: 'Filipino',
    mtName: 'Filipino',
    whisper: 'tl',
    tts: ['fil-PH', 'tl-PH', 'fil', 'tl'],
  },
}

export const LANGUAGE_LIST: LanguageDef[] = Object.values(LANGUAGES)

/** Map a whisper language code back to one of our codes, preferring the given candidates. */
export function whisperCodeToLanguage(
  whisperCode: string,
  candidates: LanguageCode[],
): LanguageCode | null {
  const wc = whisperCode.toLowerCase()
  // Whisper sometimes labels Malay audio as Indonesian; treat them as the same for our purposes.
  const normalized = wc === 'id' ? 'ms' : wc
  for (const c of candidates) {
    if (LANGUAGES[c].whisper === normalized) return c
  }
  for (const def of LANGUAGE_LIST) {
    if (def.whisper === normalized) return def.code
  }
  return null
}
