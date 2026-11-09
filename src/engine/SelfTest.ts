import { Directory, File, Paths } from 'expo-file-system'
import { LANGUAGES, type LanguageCode } from '../languages'
import { initWhisper } from 'whisper.rn/index'
import { ASR_MODELS } from '../models/catalog'
import { SenseVoice } from '../../modules/sensevoice'
import { ModelManager } from '../models/ModelManager'
import { SpeechRecognizer, cleanTranscript, encoderContextFor } from './SpeechRecognizer'
import { Translator, type ContextTurn } from './Translator'

/**
 * Developer self-tests used to measure the real device. They are only reachable
 * from the Setup screen in development builds (__DEV__).
 *
 * ASR: place 16 kHz mono 16-bit WAV files in the app's document directory
 * under `selftest/` (e.g. via `adb push` + `run-as`), named `<lang>_*.wav`
 * where <lang> is en | ms | ja | zh | tl. Each file is transcribed with the
 * language forced and with auto-detection.
 */
export interface SelfTestLine {
  name: string
  text: string
  ms: number
}

const WHISPER_TO_CODE: Record<string, LanguageCode> = {
  en: 'en',
  ms: 'ms',
  ja: 'ja',
  zh: 'zh-Hans',
  zhtw: 'zh-Hant',
  tl: 'tl',
}

function parseWav(bytes: Uint8Array): Int16Array {
  // Minimal RIFF parser: find the "data" chunk and return its PCM16 payload.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 12
  while (pos + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
    const size = dv.getUint32(pos + 4, true)
    if (id === 'data') {
      const start = bytes.byteOffset + pos + 8
      return new Int16Array(bytes.buffer.slice(start, start + size))
    }
    pos += 8 + size + (size % 2)
  }
  throw new Error('No data chunk in WAV')
}

export async function runAsrSelfTest(log: (l: SelfTestLine) => void): Promise<void> {
  const dir = new Directory(Paths.document, 'selftest')
  if (!dir.exists) {
    log({ name: 'selftest/', text: 'directory not found', ms: 0 })
    return
  }
  const files = dir.list().filter((f): f is File => f instanceof File && f.name.endsWith('.wav'))
  files.sort((a, b) => a.name.localeCompare(b.name))
  for (const f of files) {
    const prefix = f.name.split(/[_.]/)[0].replace(/\d+$/, '')
    const code = WHISPER_TO_CODE[prefix]
    try {
      const pcm = parseWav(await f.bytes())
      const forced = await SpeechRecognizer.transcribePcmForTest(pcm, code ?? null, Object.values(WHISPER_TO_CODE))
      log({ name: `${f.name} (forced ${code ?? '?'})`, text: cleanTranscript(forced?.text ?? ''), ms: forced?.processingMs ?? 0 })
      const auto = await SpeechRecognizer.transcribePcmForTest(pcm, null, Object.values(WHISPER_TO_CODE))
      log({ name: `${f.name} (auto → ${auto?.detected ?? '?'})`, text: cleanTranscript(auto?.text ?? ''), ms: auto?.processingMs ?? 0 })
    } catch (e) {
      log({ name: f.name, text: `error: ${String(e)}`, ms: 0 })
    }
  }
}

export async function runMtSelfTest(log: (l: SelfTestLine) => void): Promise<void> {
  try {
    const b = await Translator.bench(64, 32)
    if (b) {
      log({ name: 'llama.cpp native benchmark (pp64 / tg32)', text: `prompt ${b.pp.toFixed(1)} tok/s · generation ${b.tg.toFixed(1)} tok/s`, ms: 0 })
      console.log(`[selftest-bench] pp64 ${b.pp.toFixed(1)} tok/s tg32 ${b.tg.toFixed(1)} tok/s`)
    }
  } catch (e) {
    log({ name: 'benchmark', text: `error: ${String(e)}`, ms: 0 })
  }
  const samples: [LanguageCode, LanguageCode, string][] = [
    ['en', 'ja', "Hey, are you coming to the party tonight or not?"],
    ['ja', 'en', 'えー、マジで？それはちょっとヤバいね。'],
    ['ms', 'zh-Hans', 'Tak apa, saya boleh tunggu. Boleh beritahu dia saya sampai pukul tujuh?'],
    ['zh-Hant', 'tl', '你們幾點關門？我可能會晚一點到。'],
    ['tl', 'en', 'Sige, kita tayo mamaya. Huwag kang male-late ha.'],
    ['en', 'ms', "Could you tell your friend Ahmad I said thanks for the tip?"],
  ]
  for (const [src, tgt, text] of samples) {
    try {
      const r = await Translator.translate(text, src, tgt, [])
      const tps = r.generateMs > 0 ? (r.tokens / (r.generateMs / 1000)).toFixed(1) : '?'
      log({
        name: `${LANGUAGES[src].label} → ${LANGUAGES[tgt].label}: ${text}`,
        text: `${r.text}\n[prompt ${r.promptTokens} new + ${r.cachedTokens} cached in ${Math.round(r.promptMs)} ms · ${r.tokens} tokens in ${Math.round(r.generateMs)} ms = ${tps} tok/s]`,
        ms: r.ms,
      })
      console.log(`[selftest-mt] ${src}->${tgt} total ${r.ms}ms prompt ${r.promptTokens}+${r.cachedTokens}c ${Math.round(r.promptMs)}ms gen ${r.tokens}tok ${Math.round(r.generateMs)}ms ${tps}tok/s :: ${r.text}`)
    } catch (e) {
      log({ name: `${src}→${tgt}`, text: `error: ${String(e)}`, ms: 0 })
    }
  }
  // Two-way conversation with growing context: the realistic case, where the target
  // language flips every turn. Reports how many prompt tokens had to be processed.
  const convo: [LanguageCode, LanguageCode, string][] = [
    ['en', 'ja', "Hi, I'm Sarah. Is this seat taken?"],
    ['ja', 'en', 'いいえ、どうぞ座ってください。'],
    ['en', 'ja', 'Thanks! Do you know if the last bus leaves at eleven or at midnight?'],
    ['ja', 'en', 'たぶん十二時だと思いますよ。'],
    ['en', 'ja', 'Great, could you tell your friend Ahmad I said thanks?'],
  ]
  const history: ContextTurn[] = []
  for (const [i, [src, tgt, text]] of convo.entries()) {
    try {
      const r = await Translator.translate(text, src, tgt, history)
      const speaker: 'A' | 'B' = i % 2 === 0 ? 'A' : 'B'
      history.push({ speaker, language: src, text })
      log({ name: `turn ${i + 1} ${LANGUAGES[src].label} → ${LANGUAGES[tgt].label}`, text: `${r.text}\n[${r.promptTokens} new + ${r.cachedTokens} cached prompt tokens in ${Math.round(r.promptMs)} ms · ${r.tokens} tokens in ${Math.round(r.generateMs)} ms]`, ms: r.ms })
      console.log(`[selftest-convo] turn ${i + 1} ${src}->${tgt} total ${r.ms}ms prompt ${r.promptTokens}+${r.cachedTokens}c ${Math.round(r.promptMs)}ms gen ${r.tokens}tok ${Math.round(r.generateMs)}ms :: ${r.text}`)
    } catch (e) {
      log({ name: `turn ${i + 1}`, text: `error: ${String(e)}`, ms: 0 })
    }
  }

  // Thread sweep: the same sentence with different CPU thread counts (big.LITTLE phones).
  const probe = 'Could you please tell the front desk that we will check out a little later tomorrow morning?'
  for (const threads of [2, 3, 4, 5, 6]) {
    try {
      // Different target each time would change the prompt; keep it identical so only threads vary.
      const r = await Translator.translate(probe, 'en', 'ja', [], undefined, undefined, { threads })
      const tps = r.generateMs > 0 ? (r.tokens / (r.generateMs / 1000)).toFixed(1) : '?'
      log({ name: `threads=${threads}`, text: `${r.tokens} tokens in ${Math.round(r.generateMs)} ms = ${tps} tok/s (prompt ${Math.round(r.promptMs)} ms)`, ms: r.ms })
      console.log(`[selftest-threads] n=${threads} gen ${r.tokens}tok ${Math.round(r.generateMs)}ms ${tps}tok/s prompt ${r.promptTokens}+${r.cachedTokens}c ${Math.round(r.promptMs)}ms`)
    } catch (e) {
      log({ name: `threads=${threads}`, text: `error: ${String(e)}`, ms: 0 })
    }
  }
}

/**
 * Compare every installed Whisper model on the self-test clips (language forced, the
 * app's decoding settings and encoder window). Loads each model in its own context,
 * so the speech engine in use is unaffected.
 */
export async function runAsrModelComparison(log: (l: SelfTestLine) => void): Promise<void> {
  const dir = new Directory(Paths.document, 'selftest')
  if (!dir.exists) {
    log({ name: 'selftest/', text: 'directory not found', ms: 0 })
    return
  }
  const files = dir.list().filter((f): f is File => f instanceof File && f.name.endsWith('.wav'))
  files.sort((a, b) => a.name.localeCompare(b.name))
  const clips: { name: string; code: string; pcm: Int16Array }[] = []
  for (const f of files) {
    const prefix = f.name.split(/[_.]/)[0].replace(/\d+$/, '')
    const code = WHISPER_TO_CODE[prefix]
    if (!code) continue
    clips.push({ name: f.name, code: LANGUAGES[code].whisper, pcm: parseWav(await f.bytes()) })
  }
  for (const m of ASR_MODELS) {
    if (!ModelManager.isReady(m)) continue
    const ctx = await initWhisper({ filePath: ModelManager.pathFor(m), useGpu: true, useCoreMLIos: false })
    try {
      // Warm-up so the first clip does not pay for page faults.
      await ctx.transcribeData(new Int16Array(16000).buffer as ArrayBuffer, { language: 'en', maxThreads: 4, temperature: 0, temperatureInc: 0, bestOf: 1, audioCtx: 512 }).promise
      for (const c of clips) {
        const started = Date.now()
        const durationMs = (c.pcm.length / 16000) * 1000
        const r = await ctx.transcribeData(c.pcm.slice().buffer as ArrayBuffer, {
          language: c.code,
          maxThreads: 4,
          temperature: 0,
          temperatureInc: 0,
          bestOf: 1,
          audioCtx: encoderContextFor(durationMs),
        }).promise
        const ms = Date.now() - started
        const text = cleanTranscript(r.result)
        log({ name: `${m.id} · ${c.name}`, text, ms })
        console.log(`[selftest-asrmodel] ${m.id} ${c.name} ${(durationMs / 1000).toFixed(1)}s → ${ms}ms :: ${text}`)
      }
    } catch (e) {
      log({ name: m.id, text: `error: ${String(e)}`, ms: 0 })
    } finally {
      await ctx.release()
    }
  }
}

/**
 * SenseVoice speed on the self-test clips in the languages it supports (CPU). NNAPI is
 * not usable: the official sherpa-onnx Android build targets API 21 and falls back to
 * the CPU. Leaves SenseVoice loaded afterwards.
 */
export async function runSenseVoiceComparison(log: (l: SelfTestLine) => void): Promise<void> {
  const dir = new Directory(Paths.document, 'selftest')
  if (!dir.exists) {
    log({ name: 'selftest/', text: 'directory not found', ms: 0 })
    return
  }
  const SV: Record<string, string> = { en: 'en', ja: 'ja', zh: 'zh', zhtw: 'zh' }
  const files = dir.list().filter((f): f is File => f instanceof File && f.name.endsWith('.wav'))
  files.sort((a, b) => a.name.localeCompare(b.name))
  const clips: { name: string; lang: string; pcm: Int16Array }[] = []
  for (const f of files) {
    const prefix = f.name.split(/[_.]/)[0].replace(/\d+$/, '')
    if (SV[prefix]) clips.push({ name: f.name, lang: SV[prefix], pcm: parseWav(await f.bytes()) })
  }
  for (const provider of ['cpu'] as const) {
    await SpeechRecognizer.loadSenseVoice(false)
    await SpeechRecognizer.loadSenseVoice(true, provider)
    const status = SpeechRecognizer.senseVoiceStatus()
    log({ name: `SenseVoice requested ${provider}`, text: status.ready ? `running on ${status.provider}` : 'not loaded', ms: 0 })
    if (!status.ready) continue
    for (const mode of ['forced', 'auto'] as const) {
      for (const c of clips) {
        const started = Date.now()
        const r = await SenseVoice.transcribe(c.pcm, mode === 'forced' ? c.lang : 'auto')
        const ms = Date.now() - started
        log({ name: `${status.provider} ${mode} · ${c.name} (${r.lang})`, text: r.text, ms })
        console.log(`[selftest-sensevoice] ${status.provider} ${mode} ${c.name} ${(c.pcm.length / 16000).toFixed(1)}s → ${ms}ms (decode ${r.ms}ms) ${r.lang} :: ${r.text}`)
      }
    }
  }
  await SpeechRecognizer.loadSenseVoice(false)
  await SpeechRecognizer.loadSenseVoice(true, 'cpu')
}
