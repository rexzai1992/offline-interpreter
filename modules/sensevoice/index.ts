import { requireOptionalNativeModule } from 'expo-modules-core'

export interface SenseVoiceResult {
  text: string
  /** Language tag such as "<|ja|>", "<|en|>", "<|zh|>" */
  lang: string
  emotion: string
  event: string
  /** Decode time in ms measured natively */
  ms: number
  provider: string
}

interface SenseVoiceNative {
  available: boolean
  load(modelPath: string, tokensPath: string, numThreads: number, provider: string): Promise<{ provider: string; loadMs: number }>
  /** Synchronous: copies the audio into native memory on the JS thread and returns a handle. */
  prepare(pcm: Int16Array): number
  transcribe(bufferId: number, sampleRate: number, language: string, useItn: boolean): Promise<SenseVoiceResult>
  discard(bufferId: number): void
  release(): Promise<void>
}

const native = requireOptionalNativeModule<SenseVoiceNative>('SenseVoice')

/** True when the native SenseVoice engine is built into this app (Android today). */
export const senseVoiceAvailable: boolean = !!native?.available

export const SenseVoice = {
  load(modelPath: string, tokensPath: string, numThreads = 4, provider: 'cpu' | 'nnapi' = 'cpu') {
    if (!native?.available) return Promise.reject(new Error('SenseVoice is not available in this build'))
    return native.load(modelPath, tokensPath, numThreads, provider)
  },
  /**
   * language: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'. useItn: number formatting and
   * punctuation (on by default).
   */
  transcribe(pcm: Int16Array, language: string, sampleRate = 16000, useItn = true): Promise<SenseVoiceResult> {
    if (!native?.available) return Promise.reject(new Error('SenseVoice is not available in this build'))
    let id: number
    try {
      id = native.prepare(pcm)
    } catch (e) {
      return Promise.reject(e)
    }
    return native.transcribe(id, sampleRate, language, useItn)
  },
  release() {
    return native?.available ? native.release() : Promise.resolve()
  },
}

/** "<|ja|>" -> "ja" */
export function senseVoiceLanguage(tag: string): string | null {
  const m = /^<\|([a-z]+)\|>$/.exec(tag.trim())
  return m ? m[1] : null
}
