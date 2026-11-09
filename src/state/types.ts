import type { LanguageCode } from '../languages'

export type Speaker = 'A' | 'B'

export interface Turn {
  id: string
  speaker: Speaker
  /** Language the utterance was recognised in (user-correctable). */
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
  /** What the speaker said (recognised or typed). */
  original: string
  /** Natural translation; empty while pending. */
  translation: string
  status: 'listening' | 'recognizing' | 'translating' | 'done' | 'error'
  /** Speech has been detected in this turn (listening feedback). */
  heard?: boolean
  /** True while `original` is a provisional transcript that may still change. */
  provisional: boolean
  /** Whisper's auto-detected language code, if auto-detect was used. */
  detectedLanguage: string | null
  error?: string
  /** A caution shown under the translation (e.g. the recognised text looks wrong). */
  note?: string
  createdAt: number
  timings?: { asrMs?: number; mtMs?: number }
}
