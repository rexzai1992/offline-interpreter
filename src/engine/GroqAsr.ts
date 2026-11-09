import { File, Paths } from 'expo-file-system'

/**
 * Optional online speech recognition through Groq's hosted Whisper large-v3-turbo
 * (OpenAI-compatible endpoint). Only used when the user turns on online voice input
 * and enters their own API key in Setup. Audio for one utterance is written to a
 * temporary WAV in the app cache, uploaded, and the file is deleted immediately.
 * Translation is not affected: it always runs on the phone.
 */
export const GROQ_MODEL = 'whisper-large-v3-turbo'
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'
const MODELS_ENDPOINT = 'https://api.groq.com/openai/v1/models'
const REQUEST_TIMEOUT_MS = 15000

export interface GroqResult {
  text: string
  /** whisper language code (en, ms, ja, zh, tl, ...) if the service reported one */
  language: string | null
  ms: number
}

/** Language names Whisper/OpenAI-style APIs return in verbose_json, mapped to codes. */
const NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  malay: 'ms',
  indonesian: 'id',
  japanese: 'ja',
  chinese: 'zh',
  mandarin: 'zh',
  tagalog: 'tl',
  filipino: 'tl',
}

export function normalizeLanguage(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const v = raw.trim().toLowerCase()
  if (NAME_TO_CODE[v]) return NAME_TO_CODE[v]
  if (/^[a-z]{2,3}(-|$)/.test(v)) return v.split('-')[0]
  return null
}

/** 16-bit mono PCM to a WAV byte array. */
export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(buf)
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  ascii(36, 'data')
  dv.setUint32(40, dataBytes, true)
  new Int16Array(buf, 44).set(pcm)
  return new Uint8Array(buf)
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(t)
  }
}

export async function transcribeWithGroq(
  pcm: Int16Array,
  sampleRate: number,
  opts: { apiKey: string; language?: string | null; prompt?: string },
): Promise<GroqResult> {
  const started = Date.now()
  const file = new File(Paths.cache, `utt-${started}-${Math.floor(Math.random() * 1e6)}.wav`)
  try {
    file.create({ overwrite: true })
    file.write(pcm16ToWav(pcm, sampleRate))
    const form = new FormData()
    // React Native's FormData uploads a local file from {uri, name, type}.
    form.append('file', { uri: file.uri, name: 'audio.wav', type: 'audio/wav' } as unknown as Blob)
    form.append('model', GROQ_MODEL)
    form.append('response_format', 'verbose_json')
    form.append('temperature', '0')
    if (opts.language) form.append('language', opts.language)
    if (opts.prompt) form.append('prompt', opts.prompt)
    const res = await fetchWithTimeout(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${opts.apiKey}` }, body: form }, REQUEST_TIMEOUT_MS)
    const body = await res.text()
    if (!res.ok) {
      let msg = body
      try {
        msg = JSON.parse(body)?.error?.message ?? body
      } catch {
        /* keep raw body */
      }
      throw new Error(`Groq ${res.status}: ${String(msg).slice(0, 200)}`)
    }
    const json = JSON.parse(body) as { text?: string; language?: string }
    return { text: (json.text ?? '').trim(), language: normalizeLanguage(json.language) ?? opts.language ?? null, ms: Date.now() - started }
  } finally {
    try {
      if (file.exists) file.delete()
    } catch {
      /* ignore */
    }
  }
}

/** Cheap key check: list models. Returns null when the key works, else an error message. */
export async function checkGroqKey(apiKey: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${apiKey}` } }, 10000)
    if (res.ok) return null
    return res.status === 401 ? 'The API key was rejected.' : `Groq returned ${res.status}.`
  } catch (e) {
    return e instanceof Error && e.name === 'AbortError' ? 'Groq did not respond (timeout).' : 'Could not reach Groq. Check the internet connection.'
  }
}
