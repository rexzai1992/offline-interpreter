import { Buffer } from 'buffer'
import { Platform } from 'react-native'
import LiveAudioStream from '@fugood/react-native-audio-pcm-stream'
import {
  initWhisper,
  initWhisperVad,
  type TranscribeFileOptions,
  type TranscribeResult,
  type WhisperContext,
  type WhisperVadContext,
} from 'whisper.rn/index'
import { LANGUAGES, whisperCodeToLanguage, type LanguageCode } from '../languages'
import { SENSEVOICE_MODEL, SENSEVOICE_TOKENS, SILERO_VAD, type ModelFile } from '../models/catalog'
import { ModelManager } from '../models/ModelManager'
import { errorMessage } from '../util/format'
import { transcribeWithGroq } from './GroqAsr'
import { writeCaptureDebug, type CaptureCut } from './captureDebug'
import { asSpeech, withCpuTurn } from './cpuTurn'
import { addQuestionMarks, fixSpokenTimes, roughAgreement, tidyCjkSpacing } from './textFix'
import { correctNames, whisperNameHint, type NameEntry } from './glossary'
import { SenseVoice, senseVoiceAvailable, senseVoiceLanguage } from '../../modules/sensevoice'

export const SAMPLE_RATE = 16000

/** Reject a capture if the microphone delivers nothing at all for this long after start. */
const NO_AUDIO_TIMEOUT_MS = 3000
/** Finalise a capture if audio stops arriving mid-utterance (audio session interrupted). */
const AUDIO_STALL_MS = 3000
/** How often the capture watchdog runs. */
const WATCHDOG_INTERVAL_MS = 200
/** Extra time the watchdog allows over `endSilenceMs` before it ends the turn without the VAD. */
const WATCHDOG_SILENCE_GRACE_MS = 500
/**
 * Minimum transcription budget before we abort whisper. Whisper always encodes a 30 s
 * window, so on a mid-range phone CPU even a 2 s clip can take 7-10 s; a tight limit
 * aborts good transcriptions.
 */
const MIN_TRANSCRIBE_TIMEOUT_MS = 30000
/** Transcription budget per second of audio, on top of the minimum. */
const TRANSCRIBE_MS_PER_AUDIO_SECOND = 8000
/**
 * After an abort request, how long we keep the queue blocked waiting for whisper to
 * return. The queue is never released while the native job may still be running,
 * otherwise the next call fails with "Context is already transcribing".
 */
const ABORT_GRACE_MS = 30000
/** Real-time factor above which provisional passes are skipped (they would delay the final pass). */
const PROVISIONAL_MAX_RTF = 0.6
/**
 * On Android the native module releases its AudioRecord on the recording thread shortly
 * after stop(); re-initialising before that thread has exited makes it release the new
 * recorder instead. Keep a short gap between stop and the next init.
 */
const ANDROID_RESTART_GAP_MS = 300

const STREAM_OPTIONS = {
  sampleRate: SAMPLE_RATE,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6, // VOICE_RECOGNITION (Android only)
  bufferSize: 2048, // bytes: 64 ms of 16 kHz PCM16; shorter chunks make end-of-turn faster
  wavFile: '', // not used: we never write audio to disk
}

export type AsrState =
  | { state: 'unloaded' }
  | { state: 'loading' }
  | { state: 'ready'; modelId: string; gpu: boolean }
  | { state: 'error'; message: string }

export interface UtteranceResult {
  text: string
  /** Language actually used for decoding */
  language: LanguageCode
  /** Whisper's detected language code (only meaningful in auto mode) */
  detected: string | null
  durationMs: number
  processingMs: number
  /** Which engine produced the text (SenseVoice results get a second opinion). */
  engine?: 'sensevoice' | 'whisper' | 'online'
}

export interface CaptureOptions {
  /** Fixed source language, or null to auto-detect among `candidates`. */
  language: LanguageCode | null
  /** Languages allowed when auto-detecting (the two conversation languages). */
  candidates: LanguageCode[]
  /** Silence (ms) after speech that ends the turn. */
  endSilenceMs?: number
  /** Hard limit for one utterance (ms). */
  maxUtteranceMs?: number
  /** Give up if no speech started within this many ms. */
  noSpeechTimeoutMs?: number
  /** Called with provisional text while the person is still speaking. */
  onProvisional?: (text: string) => void
  /** Finish early when the provisional text ends a sentence and a short pause follows. */
  semanticEndOfTurn?: boolean
  /** How often (ms) to run a provisional pass while speaking. */
  provisionalIntervalMs?: number
  onLevel?: (rms: number) => void
  onSpeechStart?: () => void
  /** Recording has ended and the utterance is being recognised (not called when nothing was said). */
  onRecognizing?: () => void
  /**
   * Continuous mode: instead of ending at the first pause, every pause of `silenceMs`
   * (or a stretch of `maxSegmentMs` without one, cut at its quietest moment) closes a
   * segment that is handed to `onSegment` while recording goes on. The capture ends
   * after `endAfterSilenceMs` without speech (0 = only on stop() or the time limits) and
   * then resolves with null; any unfinished segment is emitted first.
   */
  segments?: {
    silenceMs: number
    maxSegmentMs: number
    endAfterSilenceMs: number
    onSegment: (pcm: Int16Array) => void
  }
}

/** What `LiveAudioStream.on()` really returns (an EmitterSubscription); the bundled typings say void. */
interface StreamSubscription {
  remove: () => void
}

const noop = () => undefined

/**
 * On-device speech recognition built on whisper.cpp (whisper.rn) with a
 * Silero VAD for end-of-turn detection. Audio is captured as 16 kHz mono
 * 16-bit PCM, kept only in memory for the current utterance, and discarded
 * once it has been transcribed (or when the user corrects the language and it
 * is re-transcribed). Nothing is written to disk or sent anywhere.
 */
class SpeechRecognizerImpl {
  private whisper: WhisperContext | null = null
  /**
   * Optional second, smaller model used for languages where it is as accurate as the main
   * one. Measured on a MediaTek mid-range phone: Whisper base took ~1 s per short sentence
   * versus ~3 s for small, with equal results in English and Mandarin but clear errors in
   * Japanese, Malay and Tagalog (verification/device/asr-model-comparison.txt).
   */
  private fastWhisper: WhisperContext | null = null
  private fastModelId: string | null = null
  /** Malay-specific Whisper (Malaysian Whisper small), used for Malay pieces when loaded. */
  private malayWhisper: WhisperContext | null = null
  private vad: WhisperVadContext | null = null
  private modelId: string | null = null
  private state: AsrState = { state: 'unloaded' }
  private listeners = new Set<(s: AsrState) => void>()
  private streamInited = false
  private lastStreamStopAt = 0
  private capturing = false
  private lastAudio: Int16Array | null = null
  /** Every whisper call (warm-up, provisional, final, re-transcribe, self-test) goes through this. */
  private transcribeQueue: Promise<unknown> = Promise.resolve()
  private vadQueue: Promise<unknown> = Promise.resolve()

  getState(): AsrState {
    return this.state
  }

  subscribe(l: (s: AsrState) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private setState(s: AsrState) {
    this.state = s
    for (const l of this.listeners) l(s)
  }

  /** Online recognition (Groq). When set, final passes go online; on failure we fall back to local Whisper. */
  private online: { apiKey: string } | null = null

  /** The user's names list: a spelling hint for Whisper and near-miss repair for all engines. */
  private names: NameEntry[] = []

  setNames(entries: NameEntry[]): void {
    this.names = entries
  }

  /**
   * Whether auto-detect between these languages costs nothing extra: SenseVoice is loaded,
   * recognises both and tells them apart (it writes both Mandarin variants as one "zh").
   */
  detectsForFree(candidates: LanguageCode[]): boolean {
    if (this.online || !this.senseVoiceReady) return false
    const codes = candidates.map((c) => SENSEVOICE_LANGUAGE[c])
    return codes.every(Boolean) && new Set(codes).size === codes.length
  }

  setOnline(cfg: { apiKey: string } | null): void {
    this.online = cfg && cfg.apiKey.trim() ? { apiKey: cfg.apiKey.trim() } : null
  }

  isOnline(): boolean {
    return this.online != null
  }

  isReady(): boolean {
    return this.vad != null && (this.whisper != null || this.online != null)
  }

  /**
   * Load only the voice-activity detector, for online recognition without a local
   * Whisper model on the phone.
   */
  async loadVadOnly(): Promise<void> {
    if (this.vad && !this.whisper && this.modelId === 'online') return
    await this.unload()
    if (!ModelManager.isReady(SILERO_VAD)) {
      this.setState({ state: 'error', message: 'Voice activity model is not downloaded.' })
      throw new Error('Voice activity model is not downloaded.')
    }
    this.setState({ state: 'loading' })
    try {
      this.vad = await initWhisperVad({ filePath: ModelManager.pathFor(SILERO_VAD), useGpu: false, nThreads: 2 })
      this.modelId = 'online'
      this.setState({ state: 'ready', modelId: 'online', gpu: false })
    } catch (e) {
      await this.unload()
      this.setState({ state: 'error', message: `Could not load voice activity detection: ${errorMessage(e)}` })
      throw e
    }
  }

  async load(model: ModelFile): Promise<void> {
    if (this.whisper && this.modelId === model.id && this.vad) return
    await this.unload()
    if (!ModelManager.isReady(model)) {
      this.setState({ state: 'error', message: 'Speech recognition model is not downloaded.' })
      throw new Error('Speech recognition model is not downloaded.')
    }
    if (!ModelManager.isReady(SILERO_VAD)) {
      this.setState({ state: 'error', message: 'Voice activity model is not downloaded.' })
      throw new Error('Voice activity model is not downloaded.')
    }
    this.setState({ state: 'loading' })
    try {
      const whisper = await initWhisper({
        filePath: ModelManager.pathFor(model),
        useGpu: true,
        useCoreMLIos: false,
      })
      this.whisper = whisper
      this.vad = await initWhisperVad({
        filePath: ModelManager.pathFor(SILERO_VAD),
        useGpu: false,
        nThreads: 2,
      })
      this.modelId = model.id
      // Warm-up with one second of silence so the first real utterance does not pay
      // for page faults and thread-pool start-up. It runs on the transcription queue so
      // a capture started meanwhile cannot overlap it ("Context is already transcribing").
      try {
        await this.enqueueTranscription(() =>
          transcribeWithTimeout(
            whisper,
            new Int16Array(SAMPLE_RATE).buffer as ArrayBuffer,
            { language: 'en', maxThreads: 4, temperature: 0, temperatureInc: 0, bestOf: 1, audioCtx: encoderContextFor(1000) },
            MIN_TRANSCRIBE_TIMEOUT_MS,
            'warm-up',
          ),
        )
      } catch (e) {
        console.warn('whisper warm-up failed', e)
      }
      this.setState({ state: 'ready', modelId: model.id, gpu: whisper.gpu })
    } catch (e) {
      await this.unload()
      const msg = errorMessage(e)
      this.setState({ state: 'error', message: `Could not load speech recognition: ${msg}` })
      throw e
    }
  }

  private fastLoad: Promise<void> = Promise.resolve()

  /** Load (or with null, release) the small model used for FAST_MODEL_LANGUAGES. Calls are serialised. */
  loadFast(model: ModelFile | null): Promise<void> {
    const run = () => this.loadFastNow(model)
    const p = this.fastLoad.then(run, run)
    this.fastLoad = p.catch(noop)
    return p
  }

  private async loadFastNow(model: ModelFile | null): Promise<void> {
    if (model && this.fastWhisper && this.fastModelId === model.id) return
    if (!model && !this.fastWhisper) return
    const previous = this.fastWhisper
    this.fastWhisper = null
    this.fastModelId = null
    if (previous) {
      // Let any job using it finish before releasing the native context.
      await this.enqueueTranscription(async () => undefined).catch(noop)
      await previous.release().catch(noop)
    }
    if (!model || model.id === this.modelId || !ModelManager.isReady(model)) return
    try {
      const ctx = await initWhisper({ filePath: ModelManager.pathFor(model), useGpu: true, useCoreMLIos: false })
      await this.enqueueTranscription(() =>
        transcribeWithTimeout(
          ctx,
          new Int16Array(SAMPLE_RATE).buffer as ArrayBuffer,
          { language: 'en', maxThreads: 4, temperature: 0, temperatureInc: 0, bestOf: 1, audioCtx: encoderContextFor(1000) },
          MIN_TRANSCRIBE_TIMEOUT_MS,
          'warm-up (fast model)',
        ),
      ).catch((e: unknown) => console.warn('fast model warm-up failed', e))
      this.fastWhisper = ctx
      this.fastModelId = model.id
    } catch (e) {
      console.warn(`Could not load the fast speech model: ${errorMessage(e)}`)
    }
  }

  private malayLoad: Promise<void> = Promise.resolve()

  /** Load (or with null, release) the Malay-specific model. Calls are serialised. */
  loadMalay(model: ModelFile | null): Promise<void> {
    const run = () => this.loadMalayNow(model)
    const p = this.malayLoad.then(run, run)
    this.malayLoad = p.catch(noop)
    return p
  }

  private async loadMalayNow(model: ModelFile | null): Promise<void> {
    if (model && this.malayWhisper) return
    if (!model && !this.malayWhisper) return
    const previous = this.malayWhisper
    this.malayWhisper = null
    if (previous) {
      await this.enqueueTranscription(async () => undefined).catch(noop)
      await previous.release().catch(noop)
    }
    if (!model || !ModelManager.isReady(model)) return
    try {
      const ctx = await initWhisper({ filePath: ModelManager.pathFor(model), useGpu: true, useCoreMLIos: false })
      await this.enqueueTranscription(() =>
        transcribeWithTimeout(
          ctx,
          new Int16Array(SAMPLE_RATE).buffer as ArrayBuffer,
          { language: 'ms', maxThreads: 4, temperature: 0, temperatureInc: 0, bestOf: 1, audioCtx: encoderContextFor(1000) },
          MIN_TRANSCRIBE_TIMEOUT_MS,
          'warm-up (Malay model)',
        ),
      ).catch((e: unknown) => console.warn('Malay model warm-up failed', e))
      this.malayWhisper = ctx
      console.log('[asr] Malaysian Whisper loaded for Malay')
    } catch (e) {
      console.warn(`Could not load the Malay speech model: ${errorMessage(e)}`)
    }
  }

  /** Whether the Malay-specific model is loaded. */
  hasMalayModel(): boolean {
    return this.malayWhisper != null
  }

  /** Id of the fast model in use for English and Mandarin, if any. */
  fastModel(): string | null {
    return this.fastModelId
  }

  async unload(): Promise<void> {
    if (this.senseVoiceReady) {
      this.senseVoiceReady = false
      await SenseVoice.release().catch(noop)
    }
    const w = this.whisper
    const v = this.vad
    const f = this.fastWhisper
    const malay = this.malayWhisper
    this.malayWhisper = null
    await malay?.release().catch(noop)
    this.whisper = null
    this.vad = null
    this.fastWhisper = null
    this.fastModelId = null
    this.modelId = null
    try {
      await w?.release()
    } catch {
      /* ignore */
    }
    try {
      await f?.release()
    } catch {
      /* ignore */
    }
    try {
      await v?.release()
    } catch {
      /* ignore */
    }
    this.setState({ state: 'unloaded' })
  }

  /**
   * Prepare the microphone. On Android the native module releases its AudioRecord after every
   * stop() and start() silently does nothing until init() is called again, so re-init
   * before each capture there. On iOS init only configures the format and is done once.
   */
  private async initStream(): Promise<void> {
    if (Platform.OS === 'android') {
      const sinceStop = Date.now() - this.lastStreamStopAt
      if (sinceStop < ANDROID_RESTART_GAP_MS) await delay(ANDROID_RESTART_GAP_MS - sinceStop)
      // Returns a promise on Android (rejects with "AudioRecord initialization failed").
      await Promise.resolve(LiveAudioStream.init(STREAM_OPTIONS) as unknown)
    } else if (!this.streamInited) {
      await Promise.resolve(LiveAudioStream.init(STREAM_OPTIONS) as unknown)
      this.streamInited = true
    }
  }

  private stopStream() {
    try {
      const r = LiveAudioStream.stop() as unknown
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        ;(r as Promise<unknown>).catch(noop)
      }
    } catch {
      /* ignore */
    }
    this.lastStreamStopAt = Date.now()
  }

  isCapturing(): boolean {
    return this.capturing
  }

  /**
   * Record one utterance: wait for speech, then stop after `endSilenceMs` of
   * silence (or when `stop()` is called), and transcribe it.
   * Resolves with null if no speech was detected.
   *
   * The returned promise always settles: a watchdog timer (independent of the audio
   * callback and of the VAD) enforces the no-audio, no-speech, stall and maximum-duration
   * limits, and the transcription itself is bounded by `transcribeWithTimeout`.
   */
  captureUtterance(opts: CaptureOptions): { stop: () => void; abort?: () => void; promise: Promise<UtteranceResult | null> } {
    const whisper = this.whisper
    const vad = this.vad
    if (!whisper || !vad) {
      return {
        stop: noop,
        promise: Promise.reject(new Error('Speech recognition is not loaded.')),
      }
    }
    if (this.capturing) {
      return { stop: noop, promise: Promise.reject(new Error('Already listening.')) }
    }
    this.capturing = true

    const endSilenceMs = opts.endSilenceMs ?? 600
    const semanticSilenceMs = Math.min(350, endSilenceMs)
    const provisionalEvery = opts.provisionalIntervalMs ?? 1200
    const maxUtteranceMs = opts.maxUtteranceMs ?? 30000
    const noSpeechTimeoutMs = opts.noSpeechTimeoutMs ?? 12000

    const chunks: Int16Array[] = []
    let totalSamples = 0
    // Continuous mode bookkeeping (sample positions are absolute since capture start).
    const seg = opts.segments
    let chunksBase = 0 // absolute sample index where chunks[0] starts
    let segStart = 0
    let segHasSpeech = false
    // Absolute sample range where the VAD actually heard speech in the current segment.
    let segSpeechStart: number | null = null
    let segSpeechEnd = 0
    /** Absolute sample up to which the VAD has looked (continuous mode). */
    let vadUntil = 0
    /** Absolute sample where the most recently detected speech ended (-1 = none yet). */
    let lastSpeechEndAbs = -1
    /** Longest pause inside the current segment: the natural place to split a long one. */
    let segBestGap: { at: number; len: number } | null = null
    /** Development builds only: the whole capture and every cut, written out for inspection. */
    const debugChunks: Int16Array[] | null = __DEV__ && seg ? [] : null
    const debugCuts: CaptureCut[] = []
    /** Set by abort(): end without recognising what is left (e.g. the app went to the background). */
    let discardRemainder = false
    let speechStarted = false
    let lastSpeechAt = 0
    let startedAt = Date.now()
    let firstChunkAt = 0
    let lastChunkAt = 0
    let stopped = false
    let vadBusy = false
    let vadFailures = 0
    let vadBroken = false
    let provisionalBusy = false
    let lastProvisionalAt = 0
    let lastProvisionalEndsSentence = false
    let subscription: StreamSubscription | null = null
    let listenerAttached = false
    let watchdog: ReturnType<typeof setInterval> | null = null
    let resolveDone: () => void = noop
    let rejectDone: (e: Error) => void = noop
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    const teardown = () => {
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = null
      }
      if (listenerAttached) {
        listenerAttached = false
        try {
          if (subscription) subscription.remove()
          // The library keeps a single listener per event (on() calls removeAllListeners),
          // so replacing it with a no-op guarantees ours is gone even on older versions.
          else LiveAudioStream.on('data', noop)
        } catch {
          /* ignore */
        }
        subscription = null
      }
      this.stopStream()
    }

    /** End the capture phase. Idempotent; safe before start, after start, or twice. */
    const finish = (error?: Error) => {
      if (stopped) return
      stopped = true
      teardown()
      this.capturing = false
      if (error) rejectDone(error)
      else resolveDone()
    }

    /** Copy absolute samples [from, to) out of the chunk list. */
    const sliceAbs = (from: number, to: number): Int16Array => {
      const out = new Int16Array(Math.max(0, to - from))
      let pos = chunksBase
      let w = 0
      for (const c of chunks) {
        const cStart = pos
        const cEnd = pos + c.length
        pos = cEnd
        if (cEnd <= from) continue
        if (cStart >= to) break
        const a = Math.max(from, cStart) - cStart
        const b = Math.min(to, cEnd) - cStart
        out.set(c.subarray(a, b), w)
        w += b - a
      }
      return w === out.length ? out : out.subarray(0, w)
    }

    /** Quietest 50 ms point in the 1.5 s before `limit`, at least MIN_LONG_PIECE into the segment. */
    const quietestPoint = (limit: number): number => {
      const from = Math.max(segStart + MIN_LONG_PIECE_SAMPLES, limit - SAMPLE_RATE * 1.5, chunksBase)
      if (from >= limit) return limit
      const win = SAMPLE_RATE / 20
      const audio = sliceAbs(from, limit)
      let best = audio.length
      let bestEnergy = Number.POSITIVE_INFINITY
      for (let i = 0; i + win <= audio.length; i += win / 2) {
        let e = 0
        for (let j = i; j < i + win; j += 2) e += audio[j] * audio[j]
        if (e < bestEnergy) {
          bestEnergy = e
          best = i + win / 2
        }
      }
      return from + best
    }

    /** Forget audio before absolute sample `keepFrom` (always keeps the newest chunk). */
    const dropBefore = (keepFrom: number) => {
      while (chunks.length > 1 && chunksBase + chunks[0].length <= keepFrom) {
        chunksBase += chunks[0].length
        chunks.shift()
      }
    }

    /**
     * Close the current segment at absolute sample `at` and hand it over. Leading silence
     * is trimmed to the first detected speech (minus a short pad), and a segment with
     * almost no speech (a click, a cough, background noise) is dropped: recognisers turn
     * such audio into junk like "The." or ".".
     */
    const cutSegment = (at: number, stillSpeaking: boolean, reason: CaptureCut['reason']) => {
      if (!seg || at - segStart < SAMPLE_RATE * 0.3) return
      const speechFrom = segSpeechStart
      const speechMs = speechFrom == null ? 0 : ((Math.min(segSpeechEnd, at) - speechFrom) / SAMPLE_RATE) * 1000
      const from = speechFrom == null ? segStart : Math.max(segStart, speechFrom - SPEECH_PAD_SAMPLES)
      const pcm = sliceAbs(from, at)
      const lagMs = Math.round(((totalSamples - vadUntil) / SAMPLE_RATE) * 1000)
      segStart = at
      segBestGap = null
      segHasSpeech = stillSpeaking
      segSpeechStart = stillSpeaking ? at : null
      segSpeechEnd = stillSpeaking ? Math.max(at, lastSpeechEndAbs) : 0
      // Drop audio that no future segment or VAD window needs.
      dropBefore(Math.min(segStart, vadUntil - VAD_CONTEXT_SAMPLES))
      const tooLong = pcm.length > MAX_SANE_SEGMENT_SAMPLES
      const dropped = speechMs < MIN_SEGMENT_SPEECH_MS || tooLong
      const sec = (n: number) => (n / SAMPLE_RATE).toFixed(2)
      console.log(`[seg] ${reason} cut ${sec(from)}-${sec(at)}s, speech ${Math.round(speechMs)}ms, vad lag ${lagMs}ms${dropped ? ', dropped' : ''}`)
      if (debugChunks) debugCuts.push({ reason, from, at, speechMs: Math.round(speechMs), lagMs, dropped })
      if (dropped) {
        if (tooLong) console.warn(`[asr] dropping a ${sec(pcm.length)}s segment (audio piled up while paused)`)
        return
      }
      this.lastAudio = pcm
      try {
        seg.onSegment(pcm)
      } catch (e) {
        console.warn('[asr] onSegment failed', e)
      }
    }

    const onData = (b64: string) => {
      if (stopped) return
      const buf = Buffer.from(b64, 'base64')
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
      if (samples.length === 0) return
      const copy = new Int16Array(samples) // detach from the shared buffer
      chunks.push(copy)
      if (debugChunks) debugChunks.push(copy)
      totalSamples += copy.length
      const now = Date.now()
      if (!firstChunkAt) firstChunkAt = now
      lastChunkAt = now
      if (opts.onLevel) {
        let sum = 0
        for (let i = 0; i < copy.length; i += 4) sum += copy[i] * copy[i]
        opts.onLevel(Math.sqrt(sum / Math.max(1, copy.length / 4)) / 32768)
      }
      const elapsed = now - startedAt
      if (elapsed > maxUtteranceMs) {
        finish()
        return
      }
      if (!speechStarted && elapsed > noSpeechTimeoutMs) {
        finish()
        return
      }
      // Run VAD on every chunk (Silero's native frame is 32 ms). Turn-taking mode looks at
      // the most recent ~1 s. Continuous mode looks at everything the VAD has not seen yet
      // (plus some context), so audio that piled up while the JS thread was busy is still
      // examined and pauses are measured in audio time, not wall-clock time.
      if (vadBusy || vadBroken) return
      vadBusy = true
      let window: Int16Array
      let windowStartAbs: number
      if (seg) {
        windowStartAbs = Math.max(
          0,
          chunksBase,
          totalSamples - VAD_MAX_WINDOW_SAMPLES,
          Math.min(vadUntil - VAD_CONTEXT_SAMPLES, totalSamples - SAMPLE_RATE),
        )
        window = sliceAbs(windowStartAbs, totalSamples)
      } else {
        window = tail(chunks, Math.min(totalSamples, SAMPLE_RATE * 1.0))
        windowStartAbs = totalSamples - window.length
      }
      const windowEndAbs = windowStartAbs + window.length
      this.vadDetect(vad, toArrayBuffer(window))
        .then((segments) => {
          vadFailures = 0
          if (stopped) return
          if (seg) {
            for (const v of segments) {
              const a = windowStartAbs + vadToSamples(v.t0)
              const b = Math.min(windowEndAbs, windowStartAbs + vadToSamples(v.t1))
              if (b <= a) continue
              // A pause between this stretch of speech and the previous one.
              if (lastSpeechEndAbs >= 0 && a > lastSpeechEndAbs && b > segStart) {
                const len = a - lastSpeechEndAbs
                const at = Math.round((a + lastSpeechEndAbs) / 2)
                if (at > segStart + MIN_LONG_PIECE_SAMPLES && (!segBestGap || len >= segBestGap.len)) segBestGap = { at, len }
              }
              if (b > lastSpeechEndAbs) lastSpeechEndAbs = b
              if (b <= segStart) continue
              const aa = Math.max(a, segStart)
              segSpeechStart = segSpeechStart == null ? aa : Math.min(segSpeechStart, aa)
              segSpeechEnd = Math.max(segSpeechEnd, b)
              segHasSpeech = true
            }
            vadUntil = Math.max(vadUntil, windowEndAbs)
          }
          const windowMs = (window.length / SAMPLE_RATE) * 1000
          const chunkMs = (copy.length / SAMPLE_RATE) * 1000
          const hasRecentSpeech = segments.some((s) => vadToSamples(s.t1) / (SAMPLE_RATE / 1000) >= windowMs - chunkMs - 40)
          if (segments.length > 0 && !speechStarted) {
            speechStarted = true
            lastSpeechAt = Date.now()
            opts.onSpeechStart?.()
          }
          if (hasRecentSpeech) lastSpeechAt = Date.now()
          const silence = Date.now() - lastSpeechAt
          if (seg) {
            const quietSamples = lastSpeechEndAbs < 0 ? 0 : windowEndAbs - lastSpeechEndAbs
            const quietMs = (quietSamples / SAMPLE_RATE) * 1000
            if (segHasSpeech && quietMs > seg.silenceMs) {
              // Cut inside the pause, not at the newest sample: audio that arrived after this
              // window may already hold the next sentence.
              cutSegment(lastSpeechEndAbs + Math.min(PAUSE_CUT_PAD_SAMPLES, Math.floor(quietSamples / 2)), false, 'pause')
            } else if (
              segHasSpeech &&
              // Measured from where speech started: the lead-in silence is trimmed anyway.
              windowEndAbs - (segSpeechStart ?? segStart) > (seg.maxSegmentMs / 1000) * SAMPLE_RATE &&
              // Split a long piece only while the person is still talking. In a pause the
              // pause cut follows within moments; splitting now left a sub-second tail that
              // Whisper turned into nonsense in a speaker test. Hard limit 3 s later.
              (quietSamples < LONG_CUT_MAX_QUIET_SAMPLES || windowEndAbs - (segSpeechStart ?? segStart) > ((seg.maxSegmentMs + 3000) / 1000) * SAMPLE_RATE)
            ) {
              const gap = segBestGap
              const at = gap ? gap.at : quietestPoint(windowEndAbs)
              cutSegment(at, lastSpeechEndAbs > at, gap ? 'long-gap' : 'long-quiet')
            } else if (!segHasSpeech && windowEndAbs - segStart > SAMPLE_RATE * 2) {
              // Nothing said yet in this segment: keep only the last second of lead-in.
              segStart = windowEndAbs - SAMPLE_RATE
              dropBefore(Math.min(segStart, vadUntil - VAD_CONTEXT_SAMPLES))
            }
            if (speechStarted && seg.endAfterSilenceMs > 0 && quietMs > seg.endAfterSilenceMs) finish()
            return
          }
          if (speechStarted && silence > endSilenceMs) {
            finish()
            return
          }
          // Semantic end-of-turn: the last provisional transcript already ends a sentence.
          if (speechStarted && opts.semanticEndOfTurn && lastProvisionalEndsSentence && silence > semanticSilenceMs) {
            finish()
            return
          }
          // Provisional transcript every ~1.2 s of speech so the speaker sees progress.
          if (
            opts.onProvisional &&
            speechStarted &&
            !provisionalBusy &&
            Date.now() - lastProvisionalAt > provisionalEvery &&
            totalSamples > SAMPLE_RATE * 1.2
          ) {
            provisionalBusy = true
            lastProvisionalAt = Date.now()
            const audio = concat(chunks)
            this.runWhisper(audio, opts.language ?? opts.candidates[0], opts.candidates, true)
              .then((r) => {
                if (!stopped && r?.text) {
                  lastProvisionalEndsSentence = /[.!?。！？]["”」』]?$/.test(r.text.trim())
                  opts.onProvisional?.(r.text)
                }
              })
              .catch(noop)
              .finally(() => {
                provisionalBusy = false
              })
          }
        })
        .catch((e: unknown) => {
          vadFailures += 1
          if (vadFailures >= 5 && !vadBroken) {
            // The VAD context is gone or keeps failing: assume everything is speech and let
            // stop() / the maximum duration end the turn instead of hanging.
            vadBroken = true
            console.warn('[asr] VAD failing repeatedly, continuing without end-of-turn detection', e)
            if (!speechStarted) {
              speechStarted = true
              lastSpeechAt = Date.now()
              opts.onSpeechStart?.()
            }
          }
        })
        .finally(() => {
          vadBusy = false
        })
    }

    // Timer-driven safety net: none of these depend on the audio callback or the VAD firing.
    const tick = () => {
      if (stopped) return
      const now = Date.now()
      const elapsed = now - startedAt
      if (!firstChunkAt) {
        if (elapsed > NO_AUDIO_TIMEOUT_MS) {
          finish(new Error('Microphone produced no audio. Check that microphone access is allowed and that no other app is using it.'))
        }
        return
      }
      if (now - lastChunkAt > AUDIO_STALL_MS) {
        console.warn('[asr] audio stopped arriving, finalising capture')
        finish()
        return
      }
      if (elapsed > maxUtteranceMs) {
        finish()
        return
      }
      if (!speechStarted && elapsed > noSpeechTimeoutMs) {
        finish()
        return
      }
      if (seg) {
        // Long quiet stretch in continuous mode: end so the caller can restart cleanly.
        if (speechStarted && now - lastSpeechAt > noSpeechTimeoutMs) finish()
        return
      }
      if (speechStarted && !vadBroken && now - lastSpeechAt > endSilenceMs + WATCHDOG_SILENCE_GRACE_MS) {
        // The VAD normally ends the turn itself; this only fires if it stopped reporting.
        finish()
      }
    }

    const start = async () => {
      subscription = (LiveAudioStream.on('data', onData) as unknown as StreamSubscription | undefined) ?? null
      listenerAttached = true
      await this.initStream()
      // stop() may have been called while the stream was initialising; never open the mic then.
      if (stopped) return
      LiveAudioStream.start()
      startedAt = Date.now()
      watchdog = setInterval(tick, WATCHDOG_INTERVAL_MS)
    }

    const promise = (async () => {
      try {
        await start()
      } catch (e) {
        finish(e instanceof Error ? e : new Error(errorMessage(e)))
      }
      await done
      if (seg) {
        if (segHasSpeech && !discardRemainder) cutSegment(totalSamples, false, 'end')
        if (debugChunks && !discardRemainder) writeCaptureDebug(debugChunks, debugCuts)
        return null
      }
      if (discardRemainder || !speechStarted || totalSamples < SAMPLE_RATE * 0.3) return null
      const audio = concat(chunks)
      this.lastAudio = audio
      try {
        opts.onRecognizing?.()
      } catch {
        /* ignore */
      }
      // Any in-flight provisional pass is ahead of us on the queue; the final pass follows it.
      return this.runWhisper(audio, opts.language, opts.candidates, false)
    })()

    return {
      stop: () => finish(),
      abort: () => {
        discardRemainder = true
        finish()
      },
      promise,
    }
  }

  /** Re-transcribe the last utterance with a different (user-corrected) language. */
  async retranscribeLast(language: LanguageCode): Promise<UtteranceResult | null> {
    const audio = this.lastAudio
    if (!audio) return null
    return this.runWhisper(audio, language, [language], false)
  }

  /**
   * Second opinion on an auto-detected SenseVoice piece, run at the lowest CPU priority
   * after it has been translated. SenseVoice only knows Mandarin, Cantonese, English,
   * Japanese and Korean, so Malay comes out as nonsense in one of those ("思安黛娘",
   * "Fed gam"). Whisper base recognises Malay (3 of 3 test phrases where SenseVoice wrote
   * katakana). Returns Whisper's text when it hears a supported language outside the pair
   * and the two transcripts clearly disagree; otherwise null.
   */
  async secondOpinion(audio: Int16Array, result: UtteranceResult, candidates: LanguageCode[]): Promise<{ language: LanguageCode; text: string } | null> {
    const fast = this.fastWhisper
    if (result.engine !== 'sensevoice' || result.detected == null || !fast) return null
    const durationMs = (audio.length / SAMPLE_RATE) * 1000
    // Whisper's language guess on a fragment is unreliable (and sung lines in a phone test
    // came as 1 s pieces); a short piece is not worth a check that could relabel it.
    if (durationMs < SECOND_OPINION_MIN_MS) return null
    // An optional check: it starts only when the CPU and the recogniser are free, and new
    // speech stops it. Run in front of the next piece it delayed that piece by 0.8 s.
    const r = await withCpuTurn(async () => {
      if (this.pendingJobs > 0) return null
      let stop: (() => void) | null = null
      let cancelled = false
      const job = this.enqueueTranscription(() =>
        cancelled
          ? Promise.resolve(null)
          : transcribeWithTimeoutNow(
              fast,
              toArrayBuffer(audio),
              { language: 'auto', maxThreads: 4, temperature: 0, temperatureInc: 0, bestOf: 1, maxLen: 0, audioCtx: encoderContextFor(durationMs) },
              MIN_TRANSCRIBE_TIMEOUT_MS,
              'second opinion',
              (s) => {
                stop = s
                if (cancelled) s()
              },
            ),
      )
      const cancel = () => {
        cancelled = true
        stop?.()
      }
      this.stopSecondOpinion = cancel
      try {
        return await job
      } finally {
        if (this.stopSecondOpinion === cancel) this.stopSecondOpinion = null
      }
    }, 'idle').catch(() => null)
    if (!r || r.isAborted) return null
    const language = whisperCodeToLanguage(r.language, candidates)
    const text = cleanTranscript(r.result)
    if (!language || candidates.includes(language) || !text) return null
    const agreement = roughAgreement(result.text, text)
    console.log(`[asr] second opinion: Whisper hears ${r.language}, agreement ${agreement.toFixed(2)}`)
    return agreement < 0.35 ? { language, text } : null
  }

  /** Recognise one segment produced by continuous capture (same routing as a final pass). */
  recognizeSegment(pcm: Int16Array, language: LanguageCode | null, candidates: LanguageCode[]) {
    return this.runWhisper(pcm, language, candidates, false)
  }

  /** Development helper: transcribe raw 16 kHz PCM16 (used by the self-test). */
  transcribePcmForTest(pcm: Int16Array, language: LanguageCode | null, candidates: LanguageCode[]) {
    return this.runWhisper(pcm, language, candidates, false)
  }

  /** Forget the retained audio of the last utterance. */
  discardLastAudio() {
    this.lastAudio = null
  }

  /** VAD calls are serialised: the native VAD context rejects overlapping requests. */
  private vadDetect(vad: WhisperVadContext, pcm: ArrayBuffer) {
    const run = () =>
      vad.detectSpeechData(pcm, {
        threshold: 0.5,
        minSpeechDurationMs: 150,
        minSilenceDurationMs: 200,
        speechPadMs: 30,
      })
    const p = this.vadQueue.then(run, run)
    this.vadQueue = p.catch(noop)
    return p
  }

  /** Jobs queued or running on the whisper context. */
  private pendingJobs = 0
  /** Aborts the running second opinion (set only while it runs). */
  private stopSecondOpinion: (() => void) | null = null
  /** Real-time factor (processing / audio duration) of the last final pass, if known. */
  private lastRtf: number | null = null
  /** Aborts the provisional pass that is currently running, if any. */
  private stopProvisional: (() => void) | null = null

  /** Serialise every use of the whisper context; it only accepts one job at a time. */
  private enqueueTranscription<T>(run: () => Promise<T>): Promise<T> {
    // New recognition work outranks the optional second opinion: stop it rather than wait.
    this.stopSecondOpinion?.()
    this.pendingJobs += 1
    const wrapped = () => run().finally(() => {
      this.pendingJobs -= 1
    })
    const p = this.transcribeQueue.then(wrapped, wrapped)
    this.transcribeQueue = p.catch(noop)
    return p
  }

  /** Provisional passes only help when the device is fast enough and nothing else is waiting. */
  private provisionalAllowed(): boolean {
    // Online: every provisional pass would be a billed request; only the final pass is sent.
    if (this.online) return false
    if (!this.whisper) return false
    if (this.pendingJobs > 0) return false
    if (this.lastRtf != null && this.lastRtf > PROVISIONAL_MAX_RTF) return false
    return true
  }

  /**
   * Recognise an utterance. With auto-detect, a language outside the selected pair is
   * never accepted: recognisers sometimes pick a wrong language on short real-world
   * speech (Whisper heard English as Malay in a field test and wrote the sentence in
   * Malay). In that case the audio is recognised again in the closer of the two
   * selected languages.
   */
  private async runWhisper(
    audio: Int16Array,
    language: LanguageCode | null,
    candidates: LanguageCode[],
    provisional: boolean,
  ): Promise<UtteranceResult | null> {
    const r = await this.recognizeChecked(audio, language, candidates, provisional)
    if (!r || provisional) return r
    // Display fixes on the final text: no spaces inside Japanese/Chinese, English clock
    // times, and question marks where the wording is clearly a question.
    const text = addQuestionMarks(fixSpokenTimes(correctNames(tidyCjkSpacing(r.text), this.names), r.language), r.language)
    return text === r.text ? r : { ...r, text }
  }

  private async recognizeChecked(
    audio: Int16Array,
    language: LanguageCode | null,
    candidates: LanguageCode[],
    provisional: boolean,
  ): Promise<UtteranceResult | null> {
    const r = await this.recognizeOnce(audio, language, candidates, provisional)
    if (r && r.detected === 'nospeech') return null
    if (language && !provisional && r) return this.checkForced(r, audio, language, candidates)
    if (language || provisional || !r) return r
    const checked = await this.checkDetection(r, audio, candidates)
    // The text is usually right even when the language label is not (SenseVoice writes
    // Japanese speech in Japanese even when it calls it English): fix the label from the
    // script, so the message lands on the right speaker's side.
    const fixed = languageFromScript(checked.text, checked.language, candidates)
    if (fixed && fixed !== checked.language) {
      console.warn(`[asr] text is written like ${fixed}, not ${checked.language}; relabelled`)
      return { ...checked, language: fixed }
    }
    return checked
  }

  /**
   * Fixed language (tap-to-talk) but the text is not in that language's script. Strongly
   * accented English that SenseVoice wrote in katakana is recognised again with Whisper;
   * real Japanese or Chinese (the other person used the wrong button) is relabelled so it
   * is translated in the right direction. `candidates` is the conversation pair.
   */
  private async checkForced(r: UtteranceResult, audio: Int16Array, language: LanguageCode, candidates: LanguageCode[]): Promise<UtteranceResult> {
    const other = candidates.find((c) => c !== language)
    if (other && LANGUAGES[language].whisper === 'zh' && !candidates.some((c) => LANGUAGES[c].whisper === 'ja') && hasKana(r.text)) {
      // Chinese output with Japanese kana in it and no Japanese in the pair: the speech was
      // not Mandarin (forced decoding of English produced kana garbage in a speaker test,
      // and the translator then invented a sentence from context). Try the other language.
      console.warn(`[asr] Mandarin result has kana (${logText(r.text)}); recognising again as ${other}`)
      const again = await this.recognizeOnce(audio, other, candidates, false).catch(() => null)
      if (again && (CJK_CODES.has(LANGUAGES[other].whisper) || isMostlyLatin(again.text))) {
        return { ...again, processingMs: again.processingMs + r.processingMs }
      }
    }
    if (CJK_CODES.has(LANGUAGES[language].whisper) || isMostlyLatin(r.text)) {
      const fixed = languageFromScript(r.text, language, candidates)
      return fixed ? { ...r, language: fixed } : r
    }
    if (looksLikeTransliteratedLatin(r.text) && this.whisper && this.senseVoiceRoute(language, candidates)) {
      console.warn(`[asr] ${language} result is in katakana (${logText(r.text)}); using Whisper`)
      const again = await this.runLocal(audio, language, candidates, false).catch(() => null)
      if (again && isMostlyLatin(again.text)) return { ...again, processingMs: again.processingMs + r.processingMs }
    }
    const fixed = languageFromScript(r.text, language, candidates)
    if (fixed) console.warn(`[asr] text is written like ${fixed}, not ${language}; relabelled`)
    return fixed ? { ...r, language: fixed } : r
  }

  /** Auto-detect sanity checks that need a second recognition pass. */
  private async checkDetection(r: UtteranceResult, audio: Int16Array, candidates: LanguageCode[]): Promise<UtteranceResult> {
    const merge = (again: UtteranceResult | null) => (again ? { ...again, detected: r.detected, processingMs: again.processingMs + r.processingMs } : r)
    const mandarin = candidates.find((c) => LANGUAGES[c].whisper === 'zh')
    if (r.detected === 'yue' && mandarin) {
      // Mandarin with a Malaysian or southern accent is often detected as Cantonese, and
      // SenseVoice then writes Cantonese words ("食唔系") that translate badly. Cantonese is
      // not one of the selected languages, so recognise it again as Mandarin.
      console.warn(`[asr] detected Cantonese (${logText(r.text)}); recognising again as Mandarin`)
      const again = await this.recognizeOnce(audio, mandarin, candidates, false)
      return again && again.text ? merge(again) : r
    }
    if (!CJK_CODES.has(LANGUAGES[r.language].whisper) && hasCjk(r.text) && !isCjkMajority(r.text)) {
      // A stray Chinese or Japanese character in text recognised as English (or Malay or
      // Filipino), as in "你ha islaysia": the language guess wobbled mid-piece. Recognise it
      // again in that language and keep the retry only if it comes back clean.
      console.warn(`[asr] ${r.language} text has a stray CJK character (${logText(r.text)}); recognising again as ${r.language}`)
      const again = await this.recognizeOnce(audio, r.language, candidates, false)
      if (again && again.text && !hasCjk(again.text)) return merge(again)
      return r
    }
    if (r.detected === 'ja' && looksLikeTransliteratedLatin(r.text)) {
      // English (or Malay/Filipino) mis-detected as Japanese comes out as phonetic katakana.
      const latin = candidates.find((c) => !CJK_CODES.has(LANGUAGES[c].whisper))
      if (latin) {
        console.warn(`[asr] Japanese result is mostly katakana (${logText(r.text)}); recognising again as ${latin}`)
        let again = await this.recognizeOnce(audio, latin, candidates, false)
        if (again && !isMostlyLatin(again.text) && this.whisper && this.senseVoiceRoute(latin, candidates)) {
          // SenseVoice can keep writing strongly accented English in katakana even when told
          // it is English; Whisper writes it in Latin letters.
          console.warn(`[asr] ${latin} pass is still not in Latin letters; using Whisper`)
          again = await this.runLocal(audio, latin, candidates, false).catch(() => again)
        }
        return merge(again)
      }
    }
    if (!r.detected || detectedInPair(r.detected, candidates)) return r
    const retry = closestCandidate(r.detected, candidates)
    console.warn(`[asr] detected "${r.detected}", which is not ${candidates.join(' or ')}; recognising again as ${retry}`)
    return merge(await this.recognizeOnce(audio, retry, candidates, false))
  }

  private recognizeOnce(
    audio: Int16Array,
    language: LanguageCode | null,
    candidates: LanguageCode[],
    provisional: boolean,
  ): Promise<UtteranceResult | null> {
    if (provisional && !this.provisionalAllowed()) return Promise.resolve(null)
    // A final pass must not wait behind a provisional one: abort it, the final result supersedes it.
    if (!provisional) this.stopProvisional?.()
    if (!provisional && this.online) {
      return this.runOnline(audio, language, candidates).catch((e) => {
        if (!this.whisper) throw e
        console.warn(`[asr] online recognition failed, using on-device Whisper: ${errorMessage(e)}`)
        return this.runLocal(audio, language, candidates, false)
      })
    }
    const sv = this.senseVoiceRoute(language, candidates)
    if (sv) {
      return this.runSenseVoice(audio, sv, language, candidates, provisional).catch((e) => {
        if (!this.whisper) throw e
        console.warn(`[asr] SenseVoice failed, using Whisper: ${errorMessage(e)}`)
        return this.runLocal(audio, language, candidates, provisional)
      })
    }
    return this.runLocal(audio, language, candidates, provisional)
  }

  // ----- SenseVoice (Japanese, English, Mandarin)

  private senseVoiceReady = false
  private senseVoiceProvider: 'cpu' | 'nnapi' = 'cpu'
  private senseVoiceLoad: Promise<void> = Promise.resolve()

  /** Whether SenseVoice is loaded, and on which processor. */
  senseVoiceStatus(): { ready: boolean; provider: 'cpu' | 'nnapi'; available: boolean } {
    return { ready: this.senseVoiceReady, provider: this.senseVoiceProvider, available: senseVoiceAvailable }
  }

  /**
   * Load or release SenseVoice. It is used only when the native module exists in this
   * build (Android today) and both model files are installed. Calls are serialised.
   */
  loadSenseVoice(enabled: boolean, provider: 'cpu' | 'nnapi' = 'cpu'): Promise<void> {
    const run = async () => {
      const wanted = enabled && senseVoiceAvailable && ModelManager.isReady(SENSEVOICE_MODEL) && ModelManager.isReady(SENSEVOICE_TOKENS)
      if (wanted && this.senseVoiceReady && this.senseVoiceProvider === provider) return
      if (this.senseVoiceReady) {
        this.senseVoiceReady = false
        await this.enqueueTranscription(() => SenseVoice.release()).catch(noop)
      }
      if (!wanted) return
      try {
        const r = await this.enqueueTranscription(() =>
          SenseVoice.load(ModelManager.pathFor(SENSEVOICE_MODEL), ModelManager.pathFor(SENSEVOICE_TOKENS), 4, provider),
        )
        // Warm-up: the first decode allocates buffers.
        await this.enqueueTranscription(() => SenseVoice.transcribe(new Int16Array(SAMPLE_RATE / 2), 'en')).catch(noop)
        this.senseVoiceProvider = provider
        this.senseVoiceReady = true
        console.log(`[asr] SenseVoice loaded on ${provider} in ${r.loadMs}ms`)
      } catch (e) {
        console.warn(`[asr] SenseVoice could not be loaded (${provider}): ${errorMessage(e)}`)
        if (provider === 'nnapi') {
          // The accelerator path is optional; fall back to the CPU.
          try {
            await this.enqueueTranscription(() => SenseVoice.load(ModelManager.pathFor(SENSEVOICE_MODEL), ModelManager.pathFor(SENSEVOICE_TOKENS), 4, 'cpu'))
            this.senseVoiceProvider = 'cpu'
            this.senseVoiceReady = true
          } catch (e2) {
            console.warn(`[asr] SenseVoice CPU fallback failed: ${errorMessage(e2)}`)
          }
        }
      }
    }
    const p = this.senseVoiceLoad.then(run, run)
    this.senseVoiceLoad = p.catch(noop)
    return p
  }

  /** SenseVoice language code for this request, or null to use Whisper. */
  private senseVoiceRoute(language: LanguageCode | null, candidates: LanguageCode[]): string | null {
    if (!this.senseVoiceReady) return null
    if (language) return SENSEVOICE_LANGUAGE[language] ?? null
    // Auto-detect only when every candidate is a SenseVoice language.
    return candidates.length > 0 && candidates.every((c) => SENSEVOICE_LANGUAGE[c]) ? 'auto' : null
  }

  private runSenseVoice(
    audio: Int16Array,
    svLanguage: string,
    language: LanguageCode | null,
    candidates: LanguageCode[],
    provisional: boolean,
  ): Promise<UtteranceResult | null> {
    return asSpeech(() => this.enqueueTranscription(async () => {
      const started = Date.now()
      const durationMs = (audio.length / SAMPLE_RATE) * 1000
      const pcm = audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength ? audio : audio.slice()
      const r = await withDeadline(SenseVoice.transcribe(pcm, svLanguage), 20000, 'SenseVoice did not respond within 20 s')
      let text = cleanTranscript(r.text)
      const detected = senseVoiceLanguage(r.lang)
      if (!provisional && (detected === 'ja' || svLanguage === 'ja') && hasMangledJapaneseNumber(text)) {
        // SenseVoice's number formatting half-converts some Japanese numbers ("三千円" came
        // out as "三00円", "二千五百円" as "二五0百円"). Decode again without it; that pass
        // writes numbers correctly but drops punctuation, so the sentence end is restored.
        const plain = await withDeadline(SenseVoice.transcribe(pcm, 'ja', SAMPLE_RATE, false), 20000, 'SenseVoice did not respond within 20 s')
        const fixed = cleanTranscript(plain.text)
        if (fixed) {
          console.warn(`[asr] Japanese number came out mangled (${logText(text)}); using ${logText(fixed)}`)
          text = /[。！？!?]$/.test(fixed) ? fixed : `${fixed}${/[？?]$/.test(text) ? '？' : '。'}`
        }
      }
      let lang: LanguageCode
      if (language) lang = language
      else {
        const mapped = detected === 'zh' || detected === 'yue' ? candidates.find((c) => c === 'zh-Hans' || c === 'zh-Hant') : candidates.find((c) => SENSEVOICE_LANGUAGE[c] === detected)
        lang = mapped ?? candidates[0]
      }
      const elapsed = Date.now() - started
      if (!provisional && durationMs > 500) this.lastRtf = elapsed / durationMs
      console.log(
        `[asr] ${provisional ? 'provisional' : 'final'} (sensevoice/${r.provider}) ${(durationMs / 1000).toFixed(1)}s audio → ${elapsed}ms (decode ${r.ms}ms) lang=${language ? svLanguage : 'auto→' + (detected ?? '?')} ${logText(text)}`,
      )
      if (!text) return null
      return { text, language: lang, detected: language ? null : detected, durationMs, processingMs: elapsed, engine: 'sensevoice' as const }
    }))
  }

  private async runOnline(audio: Int16Array, language: LanguageCode | null, candidates: LanguageCode[]): Promise<UtteranceResult | null> {
    const online = this.online
    if (!online) throw new Error('Online recognition is not configured.')
    const forced = language ? LANGUAGES[language] : null
    const durationMs = (audio.length / SAMPLE_RATE) * 1000
    const r = await transcribeWithGroq(audio, SAMPLE_RATE, { apiKey: online.apiKey, language: forced?.whisper ?? null, prompt: forced?.whisperPrompt })
    const text = cleanTranscript(r.text)
    console.log(`[asr] online ${(durationMs / 1000).toFixed(1)}s audio → ${r.ms}ms lang=${forced ? forced.whisper : 'auto→' + (r.language ?? '?')} ${logText(text)}`)
    if (!text) return null
    let lang: LanguageCode
    if (forced) lang = forced.code
    else {
      const mapped = r.language ? whisperCodeToLanguage(r.language, candidates) : null
      lang = mapped && candidates.includes(mapped) ? mapped : candidates[0]
    }
    return { text, language: lang, detected: forced ? null : r.language, durationMs, processingMs: r.ms }
  }

  private runLocal(
    audio: Int16Array,
    language: LanguageCode | null,
    candidates: LanguageCode[],
    provisional: boolean,
  ): Promise<UtteranceResult | null> {
    return this.enqueueTranscription(async () => {
      const forced = language ? LANGUAGES[language] : null
      const useMalay = !!forced && forced.code === 'ms' && this.malayWhisper != null
      const useFast = !useMalay && !!forced && FAST_MODEL_LANGUAGES.has(forced.code) && this.fastWhisper != null
      const whisper = useMalay ? this.malayWhisper : useFast ? this.fastWhisper : this.whisper
      if (!whisper) throw new Error('Speech recognition is not loaded.')
      const started = Date.now()
      const durationMs = (audio.length / SAMPLE_RATE) * 1000
      const label = provisional ? 'provisional' : 'final'
      const r = await transcribeWithTimeout(
        whisper,
        toArrayBuffer(audio),
        {
          language: forced ? forced.whisper : 'auto',
          prompt: [forced?.whisperPrompt, whisperNameHint(this.names)].filter(Boolean).join(' ') || undefined,
          // Single greedy pass: no temperature fallback (up to 6 extra decodes) and no beam search.
          // On clean, VAD-trimmed utterances this costs ~0 accuracy and avoids multi-second retries.
          maxThreads: provisional ? 2 : 4,
          temperature: 0,
          temperatureInc: 0,
          bestOf: 1,
          // Whisper hallucinates on silence; keep it from inventing long tails.
          maxLen: 0,
          // Encode only as much of the 30 s window as the utterance needs (patched whisper.rn).
          audioCtx: encoderContextFor(durationMs),
        },
        MIN_TRANSCRIBE_TIMEOUT_MS + (durationMs / 1000) * TRANSCRIBE_MS_PER_AUDIO_SECOND,
        label,
        provisional
          ? (stop) => {
              this.stopProvisional = stop
            }
          : undefined,
      )
      if (provisional) this.stopProvisional = null
      else if (!r.isAborted && durationMs > 500) this.lastRtf = (Date.now() - started) / durationMs
      const text = cleanTranscript(r.result)
      console.log(
        `[asr] ${label}${useMalay ? ' (malaysian-whisper)' : useFast ? ` (${this.fastModelId})` : ''} ${(durationMs / 1000).toFixed(1)}s audio → ${Date.now() - started}ms lang=${forced ? forced.whisper : 'auto→' + r.language}${r.isAborted ? ' (aborted)' : ''} ${logText(text)}`,
      )
      let lang: LanguageCode
      if (forced) lang = forced.code
      else {
        const mapped = whisperCodeToLanguage(r.language, candidates)
        lang = mapped && candidates.includes(mapped) ? mapped : candidates[0]
      }
      if (!text) return null
      return {
        text,
        language: lang,
        detected: forced ? null : r.language,
        durationMs,
        processingMs: Date.now() - started,
      }
    })
  }
}

/**
 * Run one whisper job with a hard time limit. If it has not finished after `limitMs`
 * (a repetition/hallucination loop on a phone CPU can take tens of seconds), the job is
 * aborted through whisper.rn's `stop()` and whatever partial text whisper produced is
 * returned (`isAborted` set). We keep waiting for the original promise after the abort
 * because the native context only releases its busy flag when the job returns; resolving
 * early would make the next call fail with "Context is already transcribing".
 */
/** Whisper takes turns with the translation model for the CPU (see cpuTurn.ts). */
function transcribeWithTimeout(...args: Parameters<typeof transcribeWithTimeoutNow>): Promise<TranscribeResult> {
  return withCpuTurn(() => transcribeWithTimeoutNow(...args), 'speech')
}

async function transcribeWithTimeoutNow(
  whisper: WhisperContext,
  pcm: ArrayBuffer,
  options: TranscribeFileOptions,
  limitMs: number,
  label: string,
  onStart?: (stop: () => void) => void,
): Promise<TranscribeResult> {
  const task = await transcribeWithRetry(() => whisper.transcribeData(pcm, options))
  onStart?.(() => {
    task.stop().catch((e: unknown) => console.warn('[asr] abort failed', e))
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    console.warn(`[asr] ${label} transcription exceeded ${Math.round(limitMs)}ms, aborting`)
    task.stop().catch((e: unknown) => console.warn('[asr] abort failed', e))
  }, limitMs)
  try {
    const r = await withDeadline(
      task.promise,
      limitMs + ABORT_GRACE_MS,
      `Transcription did not stop within ${Math.round((limitMs + ABORT_GRACE_MS) / 1000)}s`,
    )
    if (timedOut || r.isAborted) {
      console.warn(`[asr] ${label} transcription aborted; using partial result ${logText(r.result)}`)
    }
    return r
  } finally {
    clearTimeout(timer)
  }
}

/** Reject if `p` has not settled within `ms`. */
function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * whisper.rn rejects a call synchronously with "Context is already transcribing" while a
 * previous job (including one that was just aborted) is still winding down natively.
 * Retry briefly instead of failing the turn.
 */
async function transcribeWithRetry<T>(start: () => T): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return start()
    } catch (e) {
      lastError = e
      if (!/already transcribing/i.test(String(e))) throw e
      await delay(100)
    }
  }
  throw lastError
}

/**
 * Whisper encodes a fixed 30 s window (1500 positions of 20 ms) no matter how short the
 * utterance is, which is most of the recognition time on a phone CPU. whisper.cpp's
 * `audio_ctx` limits the encoder to the positions actually needed. Desktop tests on all
 * five languages gave the same transcripts at 512 positions (10 s) as at 1500; below
 * that, punctuation started to drop (verification/desktop/audioctx-results.txt), so 512
 * is the floor. The window covers the utterance plus 1 s, rounded up to 64.
 */
/** Keep this much audio before the first detected speech in a segment. */
const SPEECH_PAD_SAMPLES = Math.round(SAMPLE_RATE * 0.3)
/** whisper.cpp reports VAD segment times in centiseconds, not seconds. */
const VAD_UNITS_PER_SECOND = 100
export const vadToSamples = (t: number) => Math.round((t / VAD_UNITS_PER_SECOND) * SAMPLE_RATE)
/** Audio the VAD re-reads before the part it has not seen yet (Silero needs a little lead-in). */
const VAD_CONTEXT_SAMPLES = Math.round(SAMPLE_RATE * 0.5)
/** Upper bound on one VAD window if the JS thread fell far behind. */
const VAD_MAX_WINDOW_SAMPLES = SAMPLE_RATE * 6
/** Silence kept at the end of a piece cut at a pause (the rest belongs to the next piece). */
const PAUSE_CUT_PAD_SAMPLES = Math.round(SAMPLE_RATE * 0.25)
/** A long piece is split only if speech was heard this recently (the person is still talking). */
const LONG_CUT_MAX_QUIET_SAMPLES = Math.round(SAMPLE_RATE * 0.15)
/** A long stretch is never split closer than this to its start. */
const MIN_LONG_PIECE_SAMPLES = SAMPLE_RATE * 2
/** Segments with less detected speech than this are noise (clicks, coughs, breathing). */
const MIN_SEGMENT_SPEECH_MS = 200
/** Pieces shorter than this get no Whisper second opinion on their language. */
const SECOND_OPINION_MIN_MS = 1500
/**
 * Continuous capture cuts at 8 s, so a much longer segment means audio piled up while
 * the app was paused (screen off): recognising it gives junk, so it is dropped.
 */
const MAX_SANE_SEGMENT_SAMPLES = SAMPLE_RATE * 20

const CJK_CODES = new Set(['zh', 'ja', 'ko', 'yue'])

/**
 * True when Japanese text is mostly katakana (or Latin letters), the typical result of
 * Latin-script speech being recognised as Japanese. Ordinary Japanese mixes kanji and
 * hiragana and rarely exceeds a third katakana.
 */
/** Recognised text for the log: in full while developing, only its length in release builds. */
function logText(text: string): string {
  return __DEV__ ? `"${text}"` : `${text.length} chars`
}

/** Letters by script: Latin, kana (hiragana and katakana) and Han characters. */
function scriptCounts(text: string) {
  let latin = 0
  let kana = 0
  let han = 0
  for (const ch of text) {
    if (/[A-Za-z\u00c0-\u024f]/.test(ch)) latin += 1
    else if (/[\u3040-\u30ff\uff66-\uff9f]/.test(ch) && ch !== 'ー' && ch !== '・') kana += 1
    else if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) han += 1
  }
  return { latin, kana, han }
}

/**
 * SenseVoice's half-converted Japanese numbers: a kanji numeral next to an ASCII digit
 * ("三00円", "三5号室") or a digit before 十/百 ("二五0百円"). Digits before 千/万/億 ("1万円")
 * are normal Japanese and do not count.
 */
export function hasMangledJapaneseNumber(text: string): boolean {
  return /[〇一二三四五六七八九十百千][0-9]|[0-9][十百]/.test(text)
}

/** Whether the text contains any Chinese or Japanese character. */
function hasCjk(text: string): boolean {
  const { kana, han } = scriptCounts(text)
  return kana + han > 0
}

/** Whether Chinese or Japanese characters outnumber Latin letters. */
function isCjkMajority(text: string): boolean {
  const { latin, kana, han } = scriptCounts(text)
  return kana + han >= latin
}

/** Whether the text contains at least two Japanese kana. */
function hasKana(text: string): boolean {
  return scriptCounts(text).kana >= 2
}

/** True when most letters of the text are Latin (or there are no letters at all). */
export function isMostlyLatin(text: string): boolean {
  const { latin, kana, han } = scriptCounts(text)
  return latin >= (kana + han) * 4
}

/**
 * The selected language the text's script points to, when it contradicts `language`, else
 * null. Japanese or Chinese characters labelled as a Latin-script language (or Latin text
 * labelled as Japanese or Chinese) are a wrong label, not wrong text. Kanji-only text is
 * ambiguous between Japanese and Chinese and is left alone.
 */
export function languageFromScript(text: string, language: LanguageCode, candidates: LanguageCode[]): LanguageCode | null {
  const { latin, kana, han } = scriptCounts(text)
  const cjk = kana + han
  if (latin + cjk < 2) return null
  const isCjk = (c: LanguageCode) => CJK_CODES.has(LANGUAGES[c].whisper)
  if (!isCjk(language)) {
    if (cjk === 0 || cjk < latin) return null
    const ja = candidates.find((c) => LANGUAGES[c].whisper === 'ja')
    const zh = candidates.find((c) => LANGUAGES[c].whisper === 'zh')
    return kana > 0 ? (ja ?? zh ?? null) : (zh ?? ja ?? null)
  }
  if (latin >= cjk * 4) return candidates.find((c) => !isCjk(c)) ?? null
  if (LANGUAGES[language].whisper === 'zh' && kana > 0) return candidates.find((c) => LANGUAGES[c].whisper === 'ja') ?? null
  return null
}

export function looksLikeTransliteratedLatin(text: string): boolean {
  let kana = 0
  let total = 0
  for (const ch of text) {
    if (/[\u3040-\u309f]/.test(ch)) total += 1 // hiragana
    else if (/[\u30a0-\u30ff\uff66-\uff9f]/.test(ch)) {
      if (ch !== 'ー' && ch !== '・') kana += 1
      total += 1
    } else if (/[\u4e00-\u9fff]/.test(ch)) total += 1 // kanji
    else if (/[A-Za-z]/.test(ch)) {
      kana += 1
      total += 1
    }
  }
  return total >= 4 && kana / total > 0.6
}

/** Whether a detected recogniser language code is one of the selected languages. */
export function detectedInPair(code: string, candidates: LanguageCode[]): boolean {
  const c = code.toLowerCase()
  if (c === 'zh' || c === 'yue') return candidates.some((x) => x === 'zh-Hans' || x === 'zh-Hant')
  if (c === 'id') return candidates.includes('ms')
  if (c === 'fil') return candidates.includes('tl')
  return candidates.some((x) => LANGUAGES[x].whisper === c)
}

/**
 * The selected language closest to a wrongly detected one: a Chinese-character language
 * for zh/ja/ko/yue, otherwise a Latin-script one; the first candidate if none matches.
 */
export function closestCandidate(code: string, candidates: LanguageCode[]): LanguageCode {
  const cjk = CJK_CODES.has(code.toLowerCase())
  const match = candidates.find((x) => CJK_CODES.has(LANGUAGES[x].whisper) === cjk)
  return match ?? candidates[0]
}

/** App languages SenseVoice handles, mapped to its language codes. */
const SENSEVOICE_LANGUAGE: Partial<Record<LanguageCode, string>> = { en: 'en', ja: 'ja', 'zh-Hans': 'zh', 'zh-Hant': 'zh' }

/** Languages where Whisper base matched Whisper small on our test clips. */
export const FAST_MODEL_LANGUAGES: ReadonlySet<LanguageCode> = new Set<LanguageCode>(['en', 'zh-Hans', 'zh-Hant'])

export const MIN_ENCODER_CONTEXT = 512
export const FULL_ENCODER_CONTEXT = 1500

export function encoderContextFor(durationMs: number): number {
  const needed = Math.ceil(((Math.max(0, durationMs) + 1000) / 1000) * 50)
  const rounded = Math.ceil(needed / 64) * 64
  return Math.min(FULL_ENCODER_CONTEXT, Math.max(MIN_ENCODER_CONTEXT, rounded))
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function tail(chunks: Int16Array[], n: number): Int16Array {
  const out = new Int16Array(n)
  let pos = n
  for (let i = chunks.length - 1; i >= 0 && pos > 0; i -= 1) {
    const c = chunks[i]
    const take = Math.min(c.length, pos)
    out.set(c.subarray(c.length - take), pos - take)
    pos -= take
  }
  return pos > 0 ? out.subarray(pos) : out
}

function concat(chunks: Int16Array[]): Int16Array {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Int16Array(n)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

function toArrayBuffer(a: Int16Array): ArrayBuffer {
  if (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.buffer instanceof ArrayBuffer) {
    return a.buffer
  }
  return a.slice().buffer as ArrayBuffer
}

/**
 * Remove whisper's non-speech tags such as [BLANK_AUDIO], (music), 【音楽】 or ♪ lyrics ♪,
 * and cut off repetition loops ("ありがとうございますありがとうございます…", "I'm sorry. I'm
 * sorry. I'm sorry. …") that a greedy decode without temperature fallback can fall into.
 */
export function cleanTranscript(s: string): string {
  const stripped = s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/（[^）]*）/g, (m) => (m.length < 30 ? ' ' : m))
    .replace(/\([^)]*\)/g, (m) => (/[a-z]/i.test(m) && m.length < 30 ? ' ' : m))
    .replace(/[♪♫]+[^♪♫]*[♪♫]+/g, ' ')
    .replace(/[♪♫]/g, ' ')
    .replace(/\*[^*]{1,30}\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return collapseRepetition(stripped)
}

/**
 * Truncate a transcript at the first run of a 2–40 character unit repeated 4 or more times
 * (keeping one copy), or of a single character repeated 8 or more times. Whisper almost never
 * recovers once it starts looping, so anything after the loop is dropped too.
 */
function collapseRepetition(text: string): string {
  if (text.length < 8) return text
  const single = /(.)\1{7,}/.exec(text)
  const unit = /([^\s][\s\S]{1,39}?)(?:\s*\1){3,}/.exec(text)
  let cut = text.length
  if (single && single.index + 1 < cut) cut = single.index + 1
  if (unit && unit.index + unit[1].length < cut) cut = unit.index + unit[1].length
  if (cut >= text.length) return text
  console.warn(`[asr] repetition loop detected, truncating transcript: "${text.slice(0, 80)}"`)
  return text.slice(0, cut).trim()
}

export const SpeechRecognizer = new SpeechRecognizerImpl()

export const PLATFORM_NOTE =
  Platform.OS === 'android'
    ? 'Audio is captured with AudioRecord and processed by whisper.cpp inside the app.'
    : 'Audio is captured with AudioQueue and processed by whisper.cpp inside the app.'
