import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppState, Vibration } from 'react-native'
import * as Audio from 'expo-audio'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { SpeechRecognizer, type AsrState, type UtteranceResult } from '../engine/SpeechRecognizer'
import { chineseDialect, echoesEarlierTurn } from '../engine/textFix'
import { parseNames } from '../engine/glossary'
import { Speaker } from '../engine/Speaker'
import { Translator, type ContextTurn, type TranslateResult, type TranslatorState } from '../engine/Translator'
import { LANGUAGES, type LanguageCode } from '../languages'
import { HY_MT2_Q4_K_M, MALAY_WHISPER_SMALL_Q8, SILERO_VAD, modelById, WHISPER_BASE_Q8, WHISPER_SMALL_Q8 } from '../models/catalog'
import { ModelManager, type DownloadStatus } from '../models/ModelManager'
import { errorMessage } from '../util/format'
import { appendConversation, deleteHistory } from './history'
import { DEFAULT_SETTINGS, loadGroqKey, loadSettings, saveGroqKey, saveSettings, type Settings } from './settings'
import type { Speaker as SpeakerId, Turn } from './types'

export interface InterpreterStatus {
  translator: TranslatorState
  asr: AsrState
  ttsReady: boolean
  listening: SpeakerId | null
  speaking: boolean
  micPermission: 'unknown' | 'granted' | 'denied'
  level: number
  offline: boolean
  /** Last translation's cache statistics, for the status line. */
  lastMt?: { promptTokens: number; cachedTokens: number; promptMs: number; generateMs: number }
}

/**
 * Call `fn` at most every `ms`, always delivering the latest value at the end.
 * `cancel()` drops a delivery that is still pending: call it before the final text is
 * written, or a late partial would overwrite it.
 */
function throttlePartial(fn: (text: string) => void, ms: number): ((text: string) => void) & { cancel: () => void } {
  let last = 0
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const call = (text: string) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      pending = null
      fn(text)
      return
    }
    pending = text
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        if (pending != null) {
          const p = pending
          pending = null
          fn(p)
        }
      }, ms - (now - last))
    }
  }
  return Object.assign(call, {
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    },
  })
}

const PREVIEW_TAG = 'preview'

/** Live translation of the text being typed. */
export interface DraftPreview {
  speaker: SpeakerId
  text: string
  translation: string
  status: 'translating' | 'done' | 'error'
}

interface PreviewJob {
  key: string
  /** Number of finished turns when the preview started (its translation context). */
  ctxCount: number
  gen: number
  promise: Promise<TranslateResult | null>
  result?: TranslateResult
  /** Receives streamed text once a sent turn has taken over this preview. */
  forward?: (partial: string) => void
}

const noopWarn = (e: unknown) => console.warn('keep-awake', e)

let turnCounter = 0
const newId = () => `${Date.now()}-${(turnCounter += 1)}`

// ----- timing constants
/** Pause after stopping playback before the microphone opens, so the tail of our own voice is not captured. */
const PLAYBACK_GUARD_MS = 200
/**
 * Whose side a message goes on: the speaker of the language it was spoken in, so a reply
 * in the other language never lands on the wrong side. With the same language on both
 * sides, the speaker who was listening keeps it.
 */
function sideOf(language: LanguageCode, s: Settings, listening: SpeakerId): SpeakerId {
  if (s.langA === s.langB) return listening
  return language === s.langA ? 'A' : language === s.langB ? 'B' : listening
}

/** Delay between two captures of a continuous loop (lets the audio stream settle). */
const AUTO_RELISTEN_MS = 60
const FAST_RELISTEN_MS = 30
const PINGPONG_RELISTEN_MS = 150
/** Hands-free mode keeps the microphone open this long waiting for someone to speak. */
const AUTO_NO_SPEECH_MS = 60000
const DEFAULT_NO_SPEECH_MS = 12000
const MAX_UTTERANCE_MS = 30000
/** Continuous listening: hard limit for one capture session (the loop restarts it). */
const CONTINUOUS_MAX_MS = 10 * 60 * 1000
/** A piece longer than this without a pause is cut at its quietest moment. */
const SEGMENT_MAX_MS = 8000
/** Tap-to-talk ends after this much silence; shorter pauses only close a piece. People often
 * pause about 2 s mid-turn to think, and 1.8 s cut the next sentence off in speaker tests. */
const TAP_TO_TALK_END_MS = 2500
const TRANSLATE_DEADLINE_MS = 90000

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Resolve/reject with `p`, or reject after `ms`. On timeout `onTimeout` is
 * called first (to cancel the underlying work) and the promise then gets
 * `graceMs` more to settle on its own before it is rejected.
 */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => void, graceMs = 0): Promise<T> {
  let t1: ReturnType<typeof setTimeout> | undefined
  let t2: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    if (t1) clearTimeout(t1)
    if (t2) clearTimeout(t2)
  }
  const timeout = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(`timed out after ${Math.round((ms + graceMs) / 1000)} s`))
    t1 = setTimeout(() => {
      try {
        onTimeout()
      } catch {
        /* ignore */
      }
      if (graceMs > 0) t2 = setTimeout(fail, graceMs)
      else fail()
    }, ms)
  })
  return Promise.race([p, timeout]).finally(clear)
}

/** How long to wait for platform TTS to finish `text`: 150 ms per character, 3-30 s. */
export function playbackBudgetMs(text: string): number {
  return Math.min(30000, Math.max(3000, text.length * 150))
}

/**
 * Orchestrates one conversation: settings, engines, turn capture, translation
 * and playback. Keeps finished turns in memory as translation context (the
 * Translator trims them to an append-only token budget so the KV prefix cache
 * stays warm).
 *
 * Three ways of taking turns:
 *  - manual: tap a speaker, one utterance is captured, translated and spoken
 *    (optionally "ping-pong": the other speaker's microphone opens afterwards);
 *  - fast mode: tap a speaker, listening continues and each short pause is
 *    translated as text while the microphone stays open;
 *  - auto (hands-free): the microphone stays open, the spoken language is
 *    detected, the translation is spoken, and listening resumes.
 *
 * Concurrency rules: at most one capture at a time (`listeningRef` is reserved
 * synchronously before any await); every continuation of a loop is scheduled
 * through `scheduleNext`, which is tied to a "loop generation" so that stopping
 * a mode, backgrounding or unmounting makes late callbacks no-ops.
 */
export function useInterpreter() {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [translatorState, setTranslatorState] = useState<TranslatorState>(Translator.getState())
  const [asrState, setAsrState] = useState<AsrState>(SpeechRecognizer.getState())
  const [, bump] = useState(0)
  const [listening, setListening] = useState<SpeakerId | null>(null)
  const [level, setLevel] = useState(0)
  const [micPermission, setMicPermission] = useState<InterpreterStatus['micPermission']>('unknown')
  const [modelStatus, setModelStatus] = useState<Record<string, DownloadStatus>>(() => {
    const init: Record<string, DownloadStatus> = {}
    for (const id of [HY_MT2_Q4_K_M.id, SILERO_VAD.id, WHISPER_SMALL_Q8.id]) init[id] = ModelManager.getStatus(id)
    return init
  })
  const [lastMt, setLastMt] = useState<InterpreterStatus['lastMt']>(undefined)
  const [autoActive, setAutoActive] = useState(false)
  const [fastActive, setFastActive] = useState<SpeakerId | null>(null)

  const conversationId = useRef(newId())
  const turnsRef = useRef<Turn[]>([])
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const levelAt = useRef(0)
  // Mirrors for async code and timers, updated as soon as a render commits.
  useLayoutEffect(() => {
    turnsRef.current = turns
    settingsRef.current = settings
  }, [turns, settings])

  // ----- loop bookkeeping (refs: read from async code and timers, never stale)
  /** Speaker whose capture is in progress; reserved synchronously so two captures cannot start together. */
  const listeningRef = useRef<SpeakerId | null>(null)
  /** Stops the capture in progress, if any. */
  const stopCaptureRef = useRef<(() => void) | null>(null)
  /** Ends the capture without recognising what is left (used when the app leaves the foreground). */
  const abortCaptureRef = useRef<(() => void) | null>(null)
  /** Fast mode: the speaker whose continuous listening loop is running. */
  const fastLoopRef = useRef<SpeakerId | null>(null)
  /** Hands-free conversation mode: listen → detect language → translate → speak → listen again. */
  const autoLoopRef = useRef(false)
  /** Bumped whenever loops are cancelled; scheduled continuations from an older generation are ignored. */
  const loopGen = useRef(0)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const mountedRef = useRef(true)

  const setFastLoop = useCallback((sp: SpeakerId | null) => {
    fastLoopRef.current = sp
    setFastActive(sp)
  }, [])
  const setAutoLoop = useCallback((on: boolean) => {
    autoLoopRef.current = on
    setAutoActive(on)
  }, [])

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t)
    timers.current.clear()
  }, [])

  /**
   * Stop every loop and the capture in progress. A turn that is already being
   * translated finishes on its own; only its continuation is cancelled.
   */
  const cancelLoops = useCallback(
    (opts: { silence?: boolean; discard?: boolean } = {}) => {
      loopGen.current += 1
      clearTimers()
      setFastLoop(null)
      setAutoLoop(false)
      if (opts.discard && abortCaptureRef.current) abortCaptureRef.current()
      else stopCaptureRef.current?.()
      if (opts.silence) void Speaker.stop()
    },
    [clearTimers, setAutoLoop, setFastLoop],
  )

  // Keep the screen on while the microphone is open: if the phone sleeps mid-sentence,
  // JavaScript pauses and the speech would be lost.
  useEffect(() => {
    if (listening) {
      activateKeepAwakeAsync('listening').catch(noopWarn)
      return () => {
        deactivateKeepAwake('listening').catch(noopWarn)
      }
    }
    return undefined
  }, [listening])

  // ----- settings
  useEffect(() => {
    let cancelled = false
    void loadSettings().then((s) => {
      if (cancelled) return
      setSettingsState(s)
      Speaker.setMuted(s.muted)
      setSettingsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch }
      void saveSettings(next)
      if (patch.muted !== undefined) Speaker.setMuted(patch.muted)
      return next
    })
  }, [])

  // ----- audio session: configure once, never toggle between turns (avoids route-change stalls)
  useEffect(() => {
    void Audio.setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    }).catch((e) => console.warn('audio mode', e))
  }, [])

  // Unload engines before their model files are deleted from Setup.
  useEffect(
    () =>
      ModelManager.onBeforeDelete(async (m) => {
        if (m.kind === 'translation') await Translator.unload()
        else await SpeechRecognizer.unload()
      }),
    [],
  )

  // ----- engine subscriptions
  useEffect(() => {
    const u1 = Translator.subscribe(setTranslatorState)
    const u2 = SpeechRecognizer.subscribe(setAsrState)
    const u3 = Speaker.subscribe(() => bump((n) => n + 1))
    const u4 = ModelManager.subscribe((id, s) => setModelStatus((m) => ({ ...m, [id]: s })))
    void Speaker.refreshVoices()
    return () => {
      u1()
      u2()
      u3()
      u4()
    }
  }, [])

  // Pre-warm the voices of the two selected languages (first utterance otherwise pays 0.5-2 s).
  useEffect(() => {
    if (!settingsLoaded || settings.muted) return
    void Speaker.prewarm([settings.langA, settings.langB])
  }, [settingsLoaded, settings.muted, settings.langA, settings.langB])

  // ----- optional online voice recognition (Groq)
  const [groqKey, setGroqKeyState] = useState('')
  useEffect(() => {
    void loadGroqKey().then(setGroqKeyState)
  }, [])
  const setGroqKey = useCallback(async (key: string) => {
    await saveGroqKey(key)
    setGroqKeyState(key.trim())
  }, [])
  const onlineAsr = settings.asrProvider === 'groq' && groqKey.length > 0
  useEffect(() => {
    SpeechRecognizer.setOnline(onlineAsr ? { apiKey: groqKey } : null)
  }, [onlineAsr, groqKey])

  // ----- auto-load engines when their files are present
  const asrModel = useMemo(() => modelById(settings.asrModelId) ?? WHISPER_SMALL_Q8, [settings.asrModelId])
  const translatorReadyOnDisk = ModelManager.isReady(HY_MT2_Q4_K_M)
  const whisperOnDisk = ModelManager.isReady(asrModel)
  const fastAsr = settings.fastAsrForEnZh
  const senseVoiceOn = settings.senseVoice
  const malaySelected = settings.langA === 'ms' || settings.langB === 'ms'
  // Online recognition needs only the small voice-activity model on the phone.
  const asrReadyOnDisk = ModelManager.isReady(SILERO_VAD) && (whisperOnDisk || onlineAsr)

  const loadEngines = useCallback(async () => {
    if (translatorReadyOnDisk && Translator.getState().state === 'unloaded') {
      try {
        await Translator.load()
      } catch (e) {
        console.warn('translator load', e)
      }
    }
    if (asrReadyOnDisk) {
      const s = SpeechRecognizer.getState()
      // Local Whisper is loaded whenever its file is present (it is the offline fallback);
      // without it, online recognition only needs the voice-activity detector.
      const wanted = whisperOnDisk ? asrModel.id : 'online'
      if (s.state === 'unloaded' || (s.state === 'ready' && s.modelId !== wanted)) {
        try {
          if (whisperOnDisk) await SpeechRecognizer.load(asrModel)
          else await SpeechRecognizer.loadVadOnly()
        } catch (e) {
          console.warn('asr load', e)
        }
      }
      // English and Mandarin use Whisper base when installed (about 3x faster, same accuracy there).
      const wantFast = whisperOnDisk && fastAsr && asrModel.id !== WHISPER_BASE_Q8.id && ModelManager.isReady(WHISPER_BASE_Q8)
      if (SpeechRecognizer.getState().state === 'ready') {
        await SpeechRecognizer.loadFast(wantFast ? WHISPER_BASE_Q8 : null)
        // Malay uses Malaysian Whisper when installed, loaded only while Malay is selected.
        await SpeechRecognizer.loadMalay(malaySelected && ModelManager.isReady(MALAY_WHISPER_SMALL_Q8) ? MALAY_WHISPER_SMALL_Q8 : null)
        // Japanese, English and Mandarin use SenseVoice when installed (far faster than Whisper).
        await SpeechRecognizer.loadSenseVoice(senseVoiceOn, 'cpu')
      }
    }
  }, [translatorReadyOnDisk, asrReadyOnDisk, whisperOnDisk, asrModel, fastAsr, senseVoiceOn, malaySelected])

  useEffect(() => {
    if (!settingsLoaded) return
    void loadEngines()
  }, [settingsLoaded, loadEngines, modelStatus])

  // Stop every loop, the microphone and playback when the app leaves the foreground, and on unmount.
  useEffect(() => {
    mountedRef.current = true
    const sub = AppState.addEventListener('change', (st) => {
      // Audio captured while the app is not in the foreground is discarded: JavaScript may
      // be paused then, so pause detection stops and the audio would pile up into one huge,
      // unrecognisable piece.
      if (st !== 'active') cancelLoops({ silence: true, discard: true })
    })
    return () => {
      sub.remove()
      mountedRef.current = false
      cancelLoops({ silence: true })
    }
  }, [cancelLoops])

  // ----- permissions
  const ensureMic = useCallback(async (): Promise<boolean> => {
    try {
      const cur = await Audio.getRecordingPermissionsAsync()
      if (cur.granted) {
        setMicPermission('granted')
        return true
      }
      const req = await Audio.requestRecordingPermissionsAsync()
      setMicPermission(req.granted ? 'granted' : 'denied')
      return req.granted
    } catch (e) {
      console.warn('mic permission', e)
      setMicPermission('denied')
      return false
    }
  }, [])

  // ----- turn helpers
  const patchTurn = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  const removeTurn = useCallback((id: string) => {
    setTurns((ts) => ts.filter((t) => t.id !== id))
  }, [])

  const contextFor = useCallback((excludeId: string): ContextTurn[] => {
    const ctx: ContextTurn[] = []
    for (const t of turnsRef.current) {
      if (t.id === excludeId || t.status !== 'done' || !t.original) continue
      ctx.push({ speaker: t.speaker, language: t.sourceLanguage, text: t.original })
    }
    return ctx
  }, [])

  // When the newest message is finished and nothing is being recognised or translated,
  // read the conversation into the translator's prompt cache while the next person is
  // still talking: the next translation then only processes its own new text.
  useEffect(() => {
    const last = turns[turns.length - 1]
    if (!last || last.status !== 'done') return
    if (turns.some((t) => t.status === 'translating' || t.status === 'recognizing')) return
    Translator.prefill(contextFor(''))
  }, [turns, contextFor])

  // The names list goes to the recognisers (spelling hint, near-miss repair) and the translator.
  useEffect(() => {
    const entries = parseNames(settings.names)
    SpeechRecognizer.setNames(entries)
    Translator.setNames(entries)
  }, [settings.names])

  // ----- typing preview ("translate while typing")
  // While someone types, the draft is translated in the background after a short pause.
  // The preview uses exactly the prompt the real turn would use, so when Send is pressed
  // the finished preview is committed instantly instead of translating again. A newer
  // draft interrupts the previous preview (latest wins); a real turn is never interrupted.
  const [preview, setPreview] = useState<DraftPreview | null>(null)
  const previewRef = useRef<PreviewJob | null>(null)
  const previewGen = useRef(0)

  const draftKey = useCallback((speaker: SpeakerId, text: string) => {
    const s = settingsRef.current
    const mine = speaker === 'A' ? s.langA : s.langB
    const theirs = speaker === 'A' ? s.langB : s.langA
    return { key: `${speaker}\u0001${mine}\u0001${theirs}\u0001${text}`, mine, theirs }
  }, [])

  const doneContextCount = useCallback(() => turnsRef.current.filter((t) => t.status === 'done' && t.original).length, [])

  const clearPreview = useCallback(() => {
    previewGen.current += 1
    const job = previewRef.current
    previewRef.current = null
    setPreview(null)
    if (job && !job.result) void Translator.stop(PREVIEW_TAG)
  }, [])

  const previewDraft = useCallback(
    (speaker: SpeakerId, raw: string) => {
      const text = raw.trim()
      if (!text || !Translator.isReady()) {
        clearPreview()
        return
      }
      const { key, mine, theirs } = draftKey(speaker, text)
      const ctxCount = doneContextCount()
      const current = previewRef.current
      if (current && current.key === key && current.ctxCount === ctxCount) return
      // Latest wins: interrupt the stale preview if it is the one running now.
      if (current && !current.result) void Translator.stop(PREVIEW_TAG)
      const gen = ++previewGen.current
      setPreview({ speaker, text, translation: '', status: 'translating' })
      const job: PreviewJob = { key, ctxCount, gen, promise: Promise.resolve(null) }
      const showPartial = throttlePartial((partial) => {
        if (previewGen.current === gen) setPreview((cur) => (cur ? { ...cur, translation: partial } : cur))
        job.forward?.(partial)
      }, 120)
      job.promise = Translator.translate(text, mine, theirs, contextFor(''), showPartial, undefined, {
        tag: PREVIEW_TAG,
        isStale: () => previewGen.current !== gen,
      })
        .then((r) => {
          showPartial.cancel()
          if (r.interrupted) return null
          job.result = r
          if (previewGen.current === gen) {
            setPreview({ speaker, text, translation: r.text, status: 'done' })
            setLastMt({ promptTokens: r.promptTokens, cachedTokens: r.cachedTokens, promptMs: r.promptMs, generateMs: r.generateMs })
          }
          return r
        })
        .catch((e) => {
          showPartial.cancel()
          if (previewGen.current === gen) setPreview({ speaker, text, translation: '', status: 'error' })
          console.warn('preview failed', e)
          return null
        })
      previewRef.current = job
    },
    [clearPreview, contextFor, doneContextCount, draftKey],
  )

  /** A finished (or still running) preview for exactly this draft, if the conversation has not moved on. */
  const takePreview = useCallback(
    (speaker: SpeakerId, text: string): PreviewJob | null => {
      const job = previewRef.current
      if (!job) return null
      const { key } = draftKey(speaker, text)
      if (job.key !== key || job.ctxCount !== doneContextCount()) return null
      return job
    },
    [draftKey, doneContextCount],
  )

  const persist = useCallback((all: Turn[]) => {
    if (!settingsRef.current.saveHistory) return
    void appendConversation({
      id: conversationId.current,
      startedAt: Number(conversationId.current.split('-')[0]),
      turns: all.filter((t) => t.status === 'done'),
    })
  }, [])

  /**
   * Translate a turn. While the translation streams, complete sentences are
   * enqueued to the speech engine immediately, so playback starts before the
   * whole translation is finished. Resolves when playback (if any) has ended;
   * never rejects: failures and timeouts mark the turn as 'error'.
   */
  const runTranslation = useCallback(
    async (id: string, text: string, source: LanguageCode, target: LanguageCode, speak: boolean, fromSpeech = false, presetNote?: string) => {
      patchTurn(id, { status: 'translating', translation: '', error: undefined, note: undefined, original: text, sourceLanguage: source, targetLanguage: target, provisional: false })
      if (!Translator.isReady()) {
        patchTurn(id, { status: 'error', error: 'Translation model is not loaded. Open Setup to download or load it.' })
        return
      }
      const canSpeak = speak && !Speaker.isMuted() && Speaker.hasVoice(target)
      // Coalesce streamed tokens: a re-render per token costs more than a token on a phone CPU.
      const showPartial = throttlePartial((partial) => patchTurn(id, { translation: partial }), 120)
      let res: TranslateResult
      try {
        res = await withDeadline(
          Translator.translate(
            text,
            source,
            target,
            contextFor(id),
            showPartial,
            canSpeak ? (sentence) => void Speaker.speak(sentence, target) : undefined,
            // Leave CPU for the microphone/VAD path while a fast-mode loop keeps listening.
            { threads: fastLoopRef.current ? 3 : undefined },
          ),
          TRANSLATE_DEADLINE_MS,
          // Interrupting the completion makes the pending request settle with what it has so far.
          () => void Translator.stop(),
          5000,
        )
      } catch (e) {
        showPartial.cancel()
        patchTurn(id, { status: 'error', error: `Translation failed: ${errorMessage(e)}` })
        return
      }
      showPartial.cancel()
      let done = res
      let note: string | undefined = presetNote
      // Nonsense recognised text makes the model borrow a fluent sentence from the
      // conversation context. If the result copies an earlier message, translate again
      // without context and warn that the recognised text may be wrong.
      const history = turnsRef.current.filter((t) => t.id !== id && t.status === 'done' && !!t.translation)
      if (fromSpeech && !note && !done.interrupted && done.text && echoesEarlierTurn(done.text, { text, language: source }, target, history)) {
        console.warn('[mt] translation repeats an earlier message; translating again without context')
        note = 'The recognised text may be wrong. Tap edit to correct it.'
        try {
          const again = await withDeadline(
            Translator.translate(text, source, target, [], showPartial, undefined, {
              threads: fastLoopRef.current ? 3 : undefined,
            }),
            TRANSLATE_DEADLINE_MS,
            () => void Translator.stop(),
            5000,
          )
          showPartial.cancel()
          if (!again.interrupted && again.text) done = { ...again, ms: done.ms + again.ms }
        } catch (e) {
          showPartial.cancel()
          console.warn('[mt] translation without context failed; keeping the first one', e)
        }
      }
      // Hokkien or Cantonese written as "Mandarin": say so instead of trusting the guess.
      const dialect = fromSpeech ? chineseDialect(text, source) : null
      if (!note && dialect) note = `This sounds like ${dialect}. The app understands Mandarin, so this translation may be wrong.`
      const final = done
      setLastMt({ promptTokens: final.promptTokens, cachedTokens: final.cachedTokens, promptMs: final.promptMs, generateMs: final.generateMs })
      setTurns((ts) => {
        const next = ts.map((t) => (t.id === id ? { ...t, status: 'done' as const, translation: final.text, note, timings: { ...t.timings, mtMs: final.ms } } : t))
        persist(next)
        return next
      })
      if (!canSpeak) return
      // Platform TTS occasionally never reports completion (e.g. a voice that still needs
      // downloading); bound the wait and reset the queue so `speaking` cannot stick.
      try {
        await withDeadline(Speaker.waitIdle(), playbackBudgetMs(final.text), () => void Speaker.stop(), 500)
      } catch {
        console.warn('playback did not finish in time; stopped')
      }
    },
    [contextFor, patchTurn, persist],
  )

  // ----- listening
  const startListeningRef = useRef<(speaker: SpeakerId, auto?: boolean) => Promise<void>>(async () => undefined)

  /**
   * Schedule the next capture of a loop. What to do is decided when the timer
   * fires (from the mode refs), so a mode switched on while a capture was still
   * settling is picked up, and a mode switched off is not resumed.
   * `nextManual` is the ping-pong target when no loop is running.
   */
  const scheduleNext = useCallback((ms: number, nextManual: SpeakerId | null) => {
    const gen = loopGen.current
    const arm = (delay: number, attempt: number) => {
      const t = setTimeout(() => {
        timers.current.delete(t)
        if (!mountedRef.current || gen !== loopGen.current || listeningRef.current) return
        if (SpeechRecognizer.isCapturing()) {
          // The recorder is still tearing down the previous capture; try again shortly (up to ~5 s).
          if (attempt < 50) arm(100, attempt + 1)
          return
        }
        if (autoLoopRef.current) void startListeningRef.current('A', true)
        else if (fastLoopRef.current) void startListeningRef.current(fastLoopRef.current)
        else if (nextManual) void startListeningRef.current(nextManual)
      }, delay)
      timers.current.add(t)
    }
    arm(ms, 0)
  }, [])

  /**
   * Capture one utterance from `speaker`, translate it and speak the result.
   * In auto (hands-free) mode the speaker is whoever's language was detected.
   * Resolves when the turn is finished (or was empty/cancelled); never rejects.
   */
  const startListening = useCallback(
    async (speaker: SpeakerId, auto = false) => {
      if (listeningRef.current) return
      if (!SpeechRecognizer.isReady() || SpeechRecognizer.isCapturing()) return
      // Reserve the microphone synchronously: a second call during the awaits below is a no-op.
      listeningRef.current = speaker
      const gen = loopGen.current
      const s = settingsRef.current
      const mine = speaker === 'A' ? s.langA : s.langB
      const theirs = speaker === 'A' ? s.langB : s.langA
      // Detecting between English, Japanese and Mandarin is free with SenseVoice, so it is
      // always on for those pairs: the person who speaks decides the side, not the button.
      const detect = auto || s.autoDetect || SpeechRecognizer.detectsForFree([mine, theirs])
      const fast = s.fastMode && !auto
      // Every voice mode now listens continuously and translates each pause-delimited
      // piece while the person keeps talking. Tap-to-talk ends after a longer silence;
      // hands-free and fast mode keep listening.
      const continuous = true
      const id = newId()
      let turnCreated = false
      const ensureTurn = () => {
        if (turnCreated) return
        turnCreated = true
        const turn: Turn = {
          id,
          speaker,
          sourceLanguage: mine,
          targetLanguage: theirs,
          original: '',
          translation: '',
          status: 'listening',
          provisional: true,
          detectedLanguage: null,
          createdAt: Date.now(),
        }
        setTurns((ts) => [...ts, turn])
      }
      // Release exactly once: after this, another capture may own `listeningRef`.
      let reserved = true
      const release = () => {
        if (!reserved) return
        reserved = false
        listeningRef.current = null
        stopCaptureRef.current = null
        abortCaptureRef.current = null
        setListening(null)
        setLevel(0)
      }

      let result: UtteranceResult | null = null
      let failed = false
      try {
        if (!(await ensureMic())) return
        // Never listen while we are speaking a translation; after cutting playback,
        // leave a short gap so its tail is not captured as the next utterance.
        const wasSpeaking = Speaker.isSpeaking()
        await Speaker.stop()
        if (auto || wasSpeaking) await delay(PLAYBACK_GUARD_MS)
        if (gen !== loopGen.current || !mountedRef.current) return // cancelled while waiting

        // In continuous mode each recognised piece gets its own bubble (handleSegment),
        // so no "listening" bubble is created here; the level bar and the mic button show
        // that the app is listening.
        if (!auto && !continuous) ensureTurn()
        setListening(speaker)
        const handleSegment = (pcm: Int16Array) => {
          // Not checked against loopGen: tapping stop ends the loop but the sentence being
          // spoken (flushed as the last piece) must still be translated. Captures that should
          // be thrown away (background, clear) are aborted, which flushes nothing.
          if (!mountedRef.current) return
          const segId = newId()
          // Every piece is detected on its own: in a real conversation a short reply ("Hai",
          // "Okay") usually comes from the other person, so copying the previous piece's
          // language put replies on the wrong side. The recogniser cross-checks the label
          // against the script of the text instead (SpeechRecognizer.runWhisper).
          const segLanguage: LanguageCode | null = detect ? null : mine
          setTurns((ts) => [
            ...ts,
            { id: segId, speaker, sourceLanguage: mine, targetLanguage: theirs, original: '', translation: '', status: 'recognizing', provisional: false, detectedLanguage: null, createdAt: Date.now() },
          ])
          SpeechRecognizer.recognizeSegment(pcm, segLanguage, [mine, theirs])
            .then((seg) => {
              if (!seg) {
                removeTurn(segId)
                return
              }
              const src: LanguageCode = seg.language === theirs ? theirs : mine
              const tgt = src === mine ? theirs : mine
              const who = sideOf(src, settingsRef.current, speaker)
              patchTurn(segId, { speaker: who, original: seg.text, sourceLanguage: src, targetLanguage: tgt, detectedLanguage: seg.detected, timings: { asrMs: seg.processingMs } })
              // Text only while the microphone stays open: speech output would be recorded.
              void runTranslation(segId, seg.text, src, tgt, false, true).then(async () => {
                // Second opinion: was this really Mandarin/English, or Malay that SenseVoice
                // could not understand? If Whisper hears another supported language, show
                // its text, translate that, and say which language to choose.
                const other = await SpeechRecognizer.secondOpinion(pcm, seg, [mine, theirs]).catch(() => null)
                if (!other || !mountedRef.current) return
                const now = turnsRef.current.find((t) => t.id === segId)
                if (!now || now.original !== seg.text) return // corrected or cleared meanwhile
                const heard = LANGUAGES[other.language].label
                const note = `This sounds like ${heard}, not ${LANGUAGES[mine].label} or ${LANGUAGES[theirs].label}. Choose ${heard} for one speaker for the best translation.`
                void runTranslation(segId, other.text, src, tgt, false, true, note)
              })
            })
            .catch((e) => patchTurn(segId, { status: 'error', error: `Speech recognition failed: ${errorMessage(e)}` }))
        }
        const wantProvisional = (s.provisional || s.semanticEndOfTurn) && !fast && !continuous
        const noSpeechTimeoutMs = auto ? AUTO_NO_SPEECH_MS : DEFAULT_NO_SPEECH_MS
        const capture = SpeechRecognizer.captureUtterance({
          language: detect ? null : mine,
          candidates: detect ? [mine, theirs] : [mine],
          endSilenceMs: fast ? Math.min(s.endSilenceMs, 450) : s.endSilenceMs,
          maxUtteranceMs: continuous ? CONTINUOUS_MAX_MS : MAX_UTTERANCE_MS,
          segments: continuous
            ? {
                silenceMs: fast ? Math.min(s.endSilenceMs, 450) : s.endSilenceMs,
                maxSegmentMs: SEGMENT_MAX_MS,
                endAfterSilenceMs: auto || fast ? 0 : TAP_TO_TALK_END_MS,
                onSegment: handleSegment,
              }
            : undefined,
          semanticEndOfTurn: s.semanticEndOfTurn && !fast,
          provisionalIntervalMs: 1200,
          noSpeechTimeoutMs,
          onLevel: (l) => {
            // Throttle level updates to ~10 Hz so the mic meter does not re-render per chunk.
            const now = Date.now()
            if (now - levelAt.current > 100) {
              levelAt.current = now
              setLevel(l)
            }
          },
          onSpeechStart: continuous
            ? undefined
            : () => {
                ensureTurn()
                patchTurn(id, { heard: true })
              },
          onRecognizing: continuous
            ? undefined
            : () => {
                ensureTurn()
                patchTurn(id, { status: 'recognizing' })
              },
          onProvisional: wantProvisional ? (text) => patchTurn(id, { original: text, provisional: true }) : undefined,
        })
        stopCaptureRef.current = capture.stop
        abortCaptureRef.current = capture.abort ?? capture.stop
        try {
          // The recorder only checks its own timeouts when audio arrives; if the stream
          // stalls, stop it ourselves and give the final transcription a moment to settle.
          result = await withDeadline(capture.promise, noSpeechTimeoutMs + (continuous ? CONTINUOUS_MAX_MS : MAX_UTTERANCE_MS) + 5000, capture.stop, 20000)
        } finally {
          release()
        }

        if (!result) {
          // No speech: nothing to show. The loop (if any) simply listens again.
          if (turnCreated) removeTurn(id)
          return
        }
        ensureTurn()
        Vibration.vibrate(30)
        // The recogniser only returns one of the candidates, but settings may have been
        // swapped meanwhile; anything outside the pair is treated as this speaker's language.
        const src: LanguageCode = result.language === theirs ? theirs : mine
        const tgt = src === mine ? theirs : mine
        const who = sideOf(src, s, speaker)
        patchTurn(id, { status: 'recognizing', speaker: who, original: result.text, provisional: false, detectedLanguage: result.detected, timings: { asrMs: result.processingMs } })
        if (fast) {
          // Fast mode: translate this chunk in the background and immediately listen again.
          void runTranslation(id, result.text, src, tgt, false, true)
        } else {
          await runTranslation(id, result.text, src, tgt, true, true)
        }
      } catch (e) {
        failed = true
        release()
        ensureTurn()
        patchTurn(id, { status: 'error', error: `Speech recognition failed: ${errorMessage(e)}`, provisional: false })
      } finally {
        release() // no-op unless we returned before the capture started
        if (gen === loopGen.current && mountedRef.current) {
          if (failed) {
            // Do not spin on a broken microphone/recogniser: leave the error visible and stop the loop.
            if (autoLoopRef.current || fastLoopRef.current) cancelLoops()
          } else if (autoLoopRef.current) {
            scheduleNext(AUTO_RELISTEN_MS, null)
          } else if (fastLoopRef.current) {
            scheduleNext(FAST_RELISTEN_MS, null)
          } else if (result && !auto && !fast && settingsRef.current.autoPingPong) {
            // Hands-free ping-pong: the other person speaks next.
            scheduleNext(PINGPONG_RELISTEN_MS, speaker === 'A' ? 'B' : 'A')
          }
        }
      }
    },
    [cancelLoops, ensureMic, patchTurn, removeTurn, runTranslation, scheduleNext],
  )
  useLayoutEffect(() => {
    startListeningRef.current = startListening
  }, [startListening])

  const stopListening = useCallback(() => {
    cancelLoops()
  }, [cancelLoops])

  /** Hands-free conversation: both people just talk; the app detects the language, translates and speaks. */
  const toggleAuto = useCallback(() => {
    if (autoLoopRef.current) {
      cancelLoops({ silence: true })
      return
    }
    setFastLoop(null)
    setAutoLoop(true)
    // A capture in progress is cut short; its continuation (scheduleNext) then enters the auto loop.
    if (listeningRef.current) stopCaptureRef.current?.()
    else void startListening('A', true)
  }, [cancelLoops, setAutoLoop, setFastLoop, startListening])

  /** Tap on a speaker button: start a turn, or in fast mode start/stop continuous listening. */
  const toggleSpeaker = useCallback(
    (speaker: SpeakerId) => {
      if (autoLoopRef.current) {
        cancelLoops({ silence: true })
        return
      }
      if (settingsRef.current.fastMode) {
        if (fastLoopRef.current === speaker) {
          cancelLoops()
          return
        }
        setFastLoop(speaker)
        // Switching speakers mid-capture: the current capture ends and the loop resumes for `speaker`.
        if (listeningRef.current) stopCaptureRef.current?.()
        else void startListening(speaker)
        return
      }
      if (listeningRef.current === speaker) cancelLoops()
      else if (!listeningRef.current) void startListening(speaker)
    },
    [cancelLoops, setFastLoop, startListening],
  )

  // ----- user actions on turns
  const correctText = useCallback(
    (id: string, text: string) => {
      const t = turnsRef.current.find((x) => x.id === id)
      if (!t) return
      void runTranslation(id, text, t.sourceLanguage, t.targetLanguage, false)
    },
    [runTranslation],
  )

  const correctLanguage = useCallback(
    async (id: string, source: LanguageCode) => {
      const t = turnsRef.current.find((x) => x.id === id)
      if (!t) return
      const s = settingsRef.current
      const target = source === s.langA ? s.langB : s.langA
      const isLast = turnsRef.current[turnsRef.current.length - 1]?.id === id
      let text = t.original
      if (isLast && SpeechRecognizer.isReady()) {
        patchTurn(id, { status: 'recognizing', sourceLanguage: source, targetLanguage: target })
        try {
          const r = await withDeadline(SpeechRecognizer.retranscribeLast(source), 30000, () => undefined)
          if (r?.text) text = r.text
        } catch (e) {
          console.warn('retranscribe', e)
        }
      }
      void runTranslation(id, text, source, target, false)
    },
    [patchTurn, runTranslation],
  )

  const replay = useCallback(async (id: string) => {
    const t = turnsRef.current.find((x) => x.id === id)
    if (!t || !t.translation) return
    await Speaker.stop()
    await Speaker.speak(t.translation, t.targetLanguage)
  }, [])

  const typeTurn = useCallback(
    (speaker: SpeakerId, raw: string) => {
      const text = raw.trim()
      if (!text) return
      const s = settingsRef.current
      const mine = speaker === 'A' ? s.langA : s.langB
      const theirs = speaker === 'A' ? s.langB : s.langA
      const id = newId()
      const previous = previewRef.current
      const job = takePreview(speaker, text)
      // A preview for different text (edited before sending) is useless now: stop it so it
      // does not delay this turn. Queued stale previews are skipped via their generation.
      if (previous && previous !== job && !previous.result) void Translator.stop(PREVIEW_TAG)
      // Detach the preview from the UI without interrupting it: the turn now owns it.
      previewGen.current += 1
      previewRef.current = null
      setPreview(null)
      const speakIt = !s.fastMode
      const commit = (r: TranslateResult) => {
        setLastMt({ promptTokens: r.promptTokens, cachedTokens: r.cachedTokens, promptMs: r.promptMs, generateMs: r.generateMs })
        setTurns((ts) => {
          const next = ts.map((t) => (t.id === id ? { ...t, status: 'done' as const, translation: r.text, timings: { ...t.timings, mtMs: r.ms } } : t))
          persist(next)
          return next
        })
        if (speakIt && !Speaker.isMuted() && Speaker.hasVoice(theirs)) void Speaker.speak(r.text, theirs)
      }
      const base: Turn = {
        id,
        speaker,
        sourceLanguage: mine,
        targetLanguage: theirs,
        original: text,
        translation: job?.result?.text ?? '',
        status: job?.result ? 'done' : 'translating',
        provisional: false,
        detectedLanguage: null,
        createdAt: Date.now(),
        timings: job?.result ? { mtMs: 0 } : undefined,
      }
      setTurns((ts) => [...ts, base])
      if (job?.result) {
        // Already translated while typing: show it instantly.
        commit({ ...job.result, ms: 0 })
        return
      }
      if (job) {
        // The preview for this exact text is still running: wait for it rather than starting over.
        job.forward = (partial) => patchTurn(id, { translation: partial })
        void job.promise.then((r) => {
          if (r && !r.interrupted) commit(r)
          else void runTranslation(id, text, mine, theirs, speakIt)
        })
        return
      }
      void runTranslation(id, text, mine, theirs, speakIt)
    },
    [runTranslation, persist, patchTurn, takePreview],
  )

  const clearConversation = useCallback(() => {
    clearPreview()
    // Discard the piece being spoken: it must not reappear in the cleared conversation.
    cancelLoops({ silence: true, discard: true })
    void Translator.stop()
    SpeechRecognizer.discardLastAudio()
    setTurns([])
    setLastMt(undefined)
    conversationId.current = newId()
  }, [cancelLoops, clearPreview])

  const swapLanguages = useCallback(() => {
    updateSettings({ langA: settings.langB, langB: settings.langA })
  }, [settings.langA, settings.langB, updateSettings])

  const wipeHistory = useCallback(() => {
    deleteHistory()
  }, [])

  const status: InterpreterStatus = {
    translator: translatorState,
    asr: asrState,
    ttsReady: Speaker.getSupport() != null,
    listening,
    speaking: Speaker.isSpeaking(),
    micPermission,
    level,
    offline: true,
    lastMt,
  }

  return {
    settings,
    settingsLoaded,
    updateSettings,
    turns,
    status,
    modelStatus,
    asrModel,
    startListening,
    stopListening,
    toggleSpeaker,
    toggleAuto,
    autoActive,
    fastLoopActive: fastActive,
    correctText,
    correctLanguage,
    replay,
    typeTurn,
    groqKeySet: groqKey.length > 0,
    setGroqKey,
    onlineAsr,
    preview,
    previewDraft,
    clearPreview,
    clearConversation,
    swapLanguages,
    wipeHistory,
    loadEngines,
    voiceSupport: Speaker.getSupport(),
    muted: Speaker.isMuted(),
  }
}

export type Interpreter = ReturnType<typeof useInterpreter>
