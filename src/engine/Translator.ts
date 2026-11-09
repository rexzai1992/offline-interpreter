import * as Device from 'expo-device'
import { withCpuTurn } from './cpuTurn'
import { nameReferences, type NameEntry } from './glossary'
import { initLlama, type LlamaContext, type NativeCompletionResult } from 'llama.rn'
import { LANGUAGES, type LanguageCode } from '../languages'
import { HY_MT2_Q4_K_M } from '../models/catalog'
import { ModelManager } from '../models/ModelManager'
import { errorMessage } from '../util/format'

/** A previous turn passed as context. Only kept in memory, never persisted by default. */
export interface ContextTurn {
  speaker: 'A' | 'B'
  language: LanguageCode
  text: string
}

export type TranslatorState =
  | { state: 'unloaded' }
  | { state: 'loading'; progress: number }
  | { state: 'ready' }
  | { state: 'error'; message: string }

export interface TranslateResult {
  text: string
  ms: number
  tokens: number
  /** Prompt tokens that had to be evaluated (not served from the KV cache). */
  promptTokens: number
  /** Prompt tokens reused from the KV cache of the previous request. */
  cachedTokens: number
  promptMs: number
  generateMs: number
  truncated: boolean
  /** True when generation was cut short by `stop()` or the hard timeout; `text` is partial. */
  interrupted?: boolean
}

/**
 * Context budget. llama.rn reuses the KV cache for the longest common token
 * prefix with the previous request, so the background block must only ever
 * GROW (append-only). A sliding window would shift every line and defeat the
 * cache. Instead we keep all finished turns until the estimated prompt size
 * exceeds the budget, then reset to the two most recent turns. Research on
 * chat translation shows two previous turns capture nearly all the benefit.
 */
export const CONTEXT_TOKEN_BUDGET = 1100
export const CONTEXT_RESET_KEEP = 2
export const N_CTX = 2048

/** Hard limits so the UI never spins forever on a stuck native completion. */
export const TRANSLATE_TIMEOUT_MS = 20000
const STOP_GRACE_MS = 3000
const WARMUP_TIMEOUT_MS = 15000

/**
 * Rough RAM requirement for the Q4_K_M model + KV cache + runtime.
 * The file is 1.06 GiB; with a 2048-token context the process needs ~1.4 GB.
 * Devices with less than 3 GB total are refused; 3-4 GB get a warning.
 */
export const MIN_TOTAL_MEMORY = 3 * 1024 * 1024 * 1024
export const RECOMMENDED_TOTAL_MEMORY = 4 * 1024 * 1024 * 1024

/**
 * Sampling parameters recommended by Tencent for Hy-MT2 1.8B/7B
 * (temperature 0.7, top_p 0.6, top_k 20, repetition_penalty 1.05).
 * The model has no default system prompt, so none is sent.
 */
const SAMPLING = {
  temperature: 0.7,
  top_p: 0.6,
  top_k: 20,
  penalty_repeat: 1.05,
  min_p: 0.05,
}

/** Chat-template control tokens; the GGUF already stops at EOS (120020), these are belt and braces. */
const STOP = ['<｜hy_place▁holder▁no▁2｜>', '<｜hy_place▁holder▁no▁8｜>', '<｜hy_User｜>', '<｜hy_Assistant｜>']

/** Approximate tokens per character for the Hy-MT2 tokenizer (measured on sample text). */
const TOKENS_PER_CHAR: Record<LanguageCode, number> = {
  en: 0.23,
  ms: 0.3,
  tl: 0.33,
  'zh-Hans': 0.54,
  'zh-Hant': 0.88,
  ja: 0.76,
}

export function estimateTokens(text: string, lang: LanguageCode): number {
  return Math.ceil(text.length * (TOKENS_PER_CHAR[lang] ?? 0.5)) + 2
}

/**
 * Prompt built from Tencent's documented templates: the "Background
 * Information" variant (for conversation context) combined with the "Style"
 * variant (for natural spoken output). Only the translation is requested.
 *
 * Layout matters for speed: the background block comes first and only grows,
 * so llama.rn's prefix cache serves every previous turn; only the new lines,
 * the instruction and the utterance are evaluated per request.
 */
/**
 * Filipino tells the time with Spanish-derived numbers ("alas diyes" = ten o'clock,
 * "ala una" = one o'clock, "alas tres y medya" = 3:30). Hy-MT2-1.8B mistranslated these
 * in most of our samples (7, 12, 19:00, 2 a.m.). Tencent's documented terminology
 * template ("Reference the following translations: X translates to Y") fixed all 20
 * test cases (verification/desktop/glossary-results.txt), so detected times are passed
 * that way.
 */
const TL_HOURS: Record<string, number> = {
  una: 1, dos: 2, tres: 3, kuwatro: 4, kwatro: 4, kuatro: 4, singko: 5, sinko: 5, sais: 6,
  siyete: 7, syete: 7, otso: 8, nuwebe: 9, diyes: 10, dyes: 10, onse: 11, dose: 12,
}
const TL_TIME_RE = new RegExp(`\\b(?:ala|alas)[\\s-]+(${Object.keys(TL_HOURS).join('|')})(\\s+y\\s+medya)?\\b`, 'gi')

function formatHour(hour: number, half: boolean, target: LanguageCode): string | null {
  switch (target) {
    case 'en':
      return half ? `${hour}:30` : `${hour} o'clock`
    case 'ja':
      return `${hour}時${half ? '半' : ''}`
    case 'zh-Hans':
      return `${hour}点${half ? '半' : ''}`
    case 'zh-Hant':
      return `${hour}點${half ? '半' : ''}`
    case 'ms':
      return `pukul ${hour}${half ? ' setengah' : ''}`
    default:
      return null
  }
}

/** Reference translations for terms the model is known to get wrong, as "X translates to Y". */
export function referenceTranslations(text: string, source: LanguageCode, target: LanguageCode): string[] {
  if (source !== 'tl') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(TL_TIME_RE)) {
    const hour = TL_HOURS[m[1].toLowerCase()]
    const formatted = hour ? formatHour(hour, !!m[2], target) : null
    const line = formatted ? `${m[0]} translates to ${formatted}` : null
    if (line && !seen.has(line.toLowerCase())) {
      seen.add(line.toLowerCase())
      out.push(line)
    }
  }
  return out
}

/**
 * The part of the prompt that does not depend on the new text or the target language:
 * the style instruction and the conversation so far. `Translator.prefill` processes it
 * ahead of time so the next request only has to read its own new text.
 */
export function promptPrefix(context: ContextTurn[]): string {
  let bg = ''
  if (context.length > 0) {
    const lines = context
      .map((t) => `Speaker ${t.speaker} (${LANGUAGES[t.language].mtName}): ${t.text}`)
      .join('\n')
    bg = `[Background Information]\nA spoken conversation between two people. Previous turns:\n${lines}\n\n`
  }
  return `${STYLE_INSTRUCTION}\n\n${bg}`
}

export function buildPrompt(text: string, target: LanguageCode, context: ContextTurn[], references: string[] = []): string {
  const tgt = LANGUAGES[target].mtName
  // Order chosen for the KV prefix cache: the part that never changes comes first, then
  // the append-only conversation, and only then the target language (which flips every
  // turn in a two-way conversation) and the new text. Measured on desktop over 48 turns:
  // 37% fewer uncached prompt tokens than putting the target language first, with
  // equivalent translations (verification/desktop/prompt-order-results.txt).
  const ref = references.length ? `Reference the following translations:\n${references.join('\n')}\n\n` : ''
  return promptPrefix(context) + ref + `Please translate the following text into ${tgt}.\n\n` + `[Source Text]\n${text}`
}

/** Tencent's "style" and "only output the result" instructions; static across requests. */
export const STYLE_INSTRUCTION =
  'Note that the translation style must strictly conform to [natural everyday spoken conversation, same tone and politeness as the speaker]. ' +
  'Only output the translated result without any additional explanation.'

function contextTokens(turns: ContextTurn[]): number {
  let total = 0
  for (const t of turns) total += estimateTokens(t.text, t.language) + 8
  return total
}

/**
 * Append-only context window (see CONTEXT_TOKEN_BUDGET). `start` is the index
 * in `context` where the current window begins (0 = everything). The window
 * keeps growing from that start until it exceeds the budget, then resets to the
 * most recent turns and returns the new start, which the caller must pass back
 * on the next request. Without remembering `start`, every request after the
 * first overflow would recompute over the whole history and degrade into a
 * sliding window, shifting the prefix and defeating the KV cache.
 */
export function selectContextWindow(context: ContextTurn[], start = 0): { turns: ContextTurn[]; start: number } {
  if (start < 0 || start >= context.length) start = 0
  const window = start > 0 ? context.slice(start) : context
  if (contextTokens(window) <= CONTEXT_TOKEN_BUDGET) return { turns: window, start }
  // Reset to the most recent turns; drop more if even those do not fit (very long turns).
  for (let keep = CONTEXT_RESET_KEEP; keep >= 0; keep--) {
    const s = Math.max(0, context.length - keep)
    const turns = context.slice(s)
    if (keep === 0 || contextTokens(turns) <= CONTEXT_TOKEN_BUDGET) return { turns, start: s }
  }
  return { turns: [], start: context.length }
}

/** Trim context to the append-only budget (see CONTEXT_TOKEN_BUDGET). */
export function selectContext(context: ContextTurn[], start = 0): ContextTurn[] {
  return selectContextWindow(context, start).turns
}

/** "Translation:", "译文：", ... prefixes the model occasionally echoes. */
const LABEL_RE = /^(?:translation|translated text|target text|output|result|译文|譯文|翻译|翻譯|翻訳|訳文|訳|terjemahan|salinan|salin|pagsasalin)\s*[:：]\s*/i
/** "Speaker A (English):", "Speaker B:", "A:", "B:" echoed from the background block. */
const SPEAKER_RE = /^(?:speaker\s*)?[ab](?:\s*\([^()]{0,40}\))?\s*[:：]\s*/i
/** Chat-template control tokens (complete, or a partial one still streaming in) at the end. */
const TRAILING_TOKEN_RE = /(?:<[|｜][^<>]*[|｜]>|<\/s>|<[|｜][^<>]*)\s*$/
const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ["'", "'"],
  ['‘', '’'],
]

/**
 * Strip wrapping quotes (only when they wrap the whole string), leading labels
 * and stray chat-template token text the model occasionally adds. Safe to call
 * on streamed partial text.
 */
export function cleanTranslation(raw: string): string {
  let t = raw.trim()
  for (let pass = 0; pass < 3; pass++) {
    const before = t
    t = t.replace(LABEL_RE, '').replace(SPEAKER_RE, '')
    while (TRAILING_TOKEN_RE.test(t)) t = t.replace(TRAILING_TOKEN_RE, '').trimEnd()
    t = t.trim()
    for (const [open, close] of QUOTE_PAIRS) {
      if (t.length > open.length + close.length && t.startsWith(open) && t.endsWith(close)) {
        const inner = t.slice(open.length, t.length - close.length)
        // Only when the pair wraps the whole string: no other quote of this pair inside
        // (e.g. `"Hi," she said. "Bye."` must keep its quotes).
        if (!inner.includes(close) && !inner.includes(open)) {
          t = inner.trim()
          break
        }
      }
    }
    if (t === before) break
  }
  return t
}

/** Words after which a period is (usually) not a sentence end. */
const ABBREV_RE = /(?:^|[\s(])(?:[A-Za-z]|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|e\.g|i\.e|approx|Inc|Ltd|Co|No|Nos|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Tel|Encik|Puan|Cik|Tn|Pn|Jln|Blk|Gg|Bhd|Sdn)\.$/i
const TERMINATOR_RE = /[.!?。！？…]+["”」』’）)]*/g

/**
 * Split streamed text into complete sentences for incremental speech output.
 * Returns the sentences that are complete and the remaining tail. A sentence
 * counts as complete only once something follows it, so a terminator that may
 * still continue ("3." before "5", "Mr." before "Smith") is never spoken early.
 * ASCII terminators must be followed by whitespace or a non-alphanumeric
 * character (no split inside "3.5", "e.g.", "example.com"); CJK terminators
 * split anywhere. Fragments shorter than 2 characters are dropped.
 */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let start = 0
  TERMINATOR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TERMINATOR_RE.exec(text)) !== null) {
    const end = m.index + m[0].length
    // Always advances at least one char, so this loop terminates.
    if (m[0].length === 0) {
      TERMINATOR_RE.lastIndex++
      continue
    }
    const run = m[0]
    const lastTerm = run.replace(/["”」』’）)]+$/, '').slice(-1)
    const ascii = lastTerm === '.' || lastTerm === '!' || lastTerm === '?'
    const next = text[end]
    if (next === undefined) break // nothing follows yet: keep in rest
    if (ascii) {
      if (/[A-Za-z0-9]/.test(next)) continue // "3.5", "e.g.", "example.com"
      if (run === '.' && ABBREV_RE.test(text.slice(start, end))) continue
    }
    // Skip whitespace; something non-space must follow for the sentence to count.
    let after = end
    while (after < text.length && /\s/.test(text[after])) after++
    if (after >= text.length) break
    const s = text.slice(start, end).trim()
    if (s.length >= 2) sentences.push(s)
    start = after
    TERMINATOR_RE.lastIndex = after
  }
  TERMINATOR_RE.lastIndex = 0
  return { sentences, rest: text.slice(start) }
}

class TranslatorImpl {
  private ctx: LlamaContext | null = null
  private activeTag: string | null = null
  private state: TranslatorState = { state: 'unloaded' }
  private listeners = new Set<(s: TranslatorState) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  /** The user's names list (see glossary.ts). */
  private names: NameEntry[] = []

  setNames(entries: NameEntry[]): void {
    this.names = entries
  }

  /** Translation requests queued or running (a prefill only runs when this is 0). */
  private pending = 0
  /** Prompt prefix last read by prefill(); cleared when a translation changes the cache. */
  private prefilled: string | null = null
  private loading: Promise<void> | null = null
  /** Bumped by unload() so a load() still in flight discards its context. */
  private generation = 0
  /** Set by stop() while a completion is running; cleared when the next one starts. */
  private stopRequested = false
  /** Where the append-only context window starts in the caller's history, and the turn found there. */
  private contextStart = 0
  private contextAnchor: ContextTurn | null = null

  getState(): TranslatorState {
    return this.state
  }

  subscribe(l: (s: TranslatorState) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private setState(s: TranslatorState) {
    this.state = s
    for (const l of this.listeners) {
      try {
        l(s)
      } catch (e) {
        console.warn('Translator listener failed', e)
      }
    }
  }

  memoryCheck(): { blocked: boolean; message: string | null } {
    const total = Device.totalMemory
    if (total == null) return { blocked: false, message: null }
    if (total < MIN_TOTAL_MEMORY) {
      return {
        blocked: true,
        message: `This device reports ${(total / 1073741824).toFixed(1)} GB of RAM. The translation model needs about 1.4 GB free and is not supported below 3 GB total.`,
      }
    }
    if (total < RECOMMENDED_TOTAL_MEMORY) {
      return {
        blocked: false,
        message: `This device has ${(total / 1073741824).toFixed(1)} GB of RAM. Translation will work but may be slow, and the OS may unload the app under memory pressure.`,
      }
    }
    return { blocked: false, message: null }
  }

  /** Load the model. Concurrent calls share one load; after a failure it can be called again. */
  load(): Promise<void> {
    if (this.ctx) return Promise.resolve()
    if (this.loading) return this.loading
    this.loading = this.doLoad().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async doLoad(): Promise<void> {
    if (!ModelManager.isReady(HY_MT2_Q4_K_M)) {
      this.setState({ state: 'error', message: 'Translation model is not downloaded.' })
      throw new Error('Translation model is not downloaded.')
    }
    const mem = this.memoryCheck()
    if (mem.blocked) {
      this.setState({ state: 'error', message: mem.message! })
      throw new Error(mem.message!)
    }
    const gen = this.generation
    this.setState({ state: 'loading', progress: 0 })
    let ctx: LlamaContext
    try {
      ctx = await initLlama(
        {
          model: ModelManager.pathFor(HY_MT2_Q4_K_M),
          n_ctx: N_CTX,
          n_batch: 512,
          n_ubatch: 512,
          // Metal on iOS. On Android llama.rn only offloads when an OpenCL (Adreno)
          // device is present and otherwise runs on the CPU with the big cores pinned.
          n_gpu_layers: 99,
          // mmap for fast load; mlock keeps weights resident so the first tokens after
          // a pause are not paid as page faults (llama.cpp only warns if mlock is refused).
          use_mmap: true,
          use_mlock: true,
          flash_attn_type: 'auto',
          ctx_shift: false,
        },
        (p) => {
          if (this.generation === gen && this.state.state === 'loading') this.setState({ state: 'loading', progress: p })
        },
      )
    } catch (e) {
      const msg = errorMessage(e)
      this.setState({
        state: 'error',
        message: /memory|alloc|mmap|OOM/i.test(msg)
          ? `Could not load the translation model: ${msg}. Close other apps and try again.`
          : `Could not load the translation model: ${msg}`,
      })
      throw e
    }
    if (this.generation !== gen) {
      // unload() was called while loading: discard what we just created.
      try {
        await ctx.release()
      } catch {
        /* ignore */
      }
      this.setState({ state: 'unloaded' })
      return
    }
    this.ctx = ctx
    this.contextStart = 0
    this.contextAnchor = null
    // Warm-up: one tiny completion touches the sampler/template paths and pre-faults
    // pages. Never allowed to fail or hang the load: errors are logged and a stuck
    // completion is interrupted after WARMUP_TIMEOUT_MS.
    try {
      await this.withTimeout(
        ctx.completion({
          messages: [{ role: 'user', content: buildPrompt('Hello.', 'ja', []) }],
          jinja: true,
          n_predict: 4,
          temperature: 0,
        }),
        WARMUP_TIMEOUT_MS,
        () => ctx.stopCompletion(),
      )
    } catch (e) {
      console.warn('Translator warm-up failed', e)
    }
    if (this.ctx === ctx) this.setState({ state: 'ready' })
  }

  /** Race `p` against a timer; on timeout run `onTimeout` and resolve with null. */
  private withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => Promise<void> | void): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(async () => {
        try {
          await onTimeout?.()
        } catch {
          /* ignore */
        }
        resolve(null)
      }, ms)
    })
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  async unload(): Promise<void> {
    this.generation++
    const c = this.ctx
    this.ctx = null
    if (c) {
      try {
        await c.stopCompletion()
      } catch {
        /* ignore */
      }
      try {
        await c.release()
      } catch (e) {
        console.warn('Translator release failed', e)
      }
    }
    this.setState({ state: 'unloaded' })
  }

  isReady(): boolean {
    return this.ctx != null && this.state.state === 'ready'
  }

  /**
   * Translate one completed utterance. Requests are serialised so two turns
   * never run on the same context concurrently. A request that is still
   * running after TRANSLATE_TIMEOUT_MS is interrupted and resolves with the
   * partial text (`interrupted: true`), so the queue and the UI never stall.
   *
   * @param onPartial   streamed partial translation (whole text so far)
   * @param onSentence  each complete sentence as soon as it is available (for incremental speech)
   */
  translate(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context: ContextTurn[],
    onPartial?: (partial: string) => void,
    onSentence?: (sentence: string) => void,
    opts?: {
      threads?: number
      timeoutMs?: number
      /** Label for this request; `stop(tag)` only interrupts a running request with the same tag. */
      tag?: string
      /** Checked when the request reaches the front of the queue; a stale request is skipped. */
      isStale?: () => boolean
    },
  ): Promise<TranslateResult> {
    const run = async (): Promise<TranslateResult> => {
      const ctx = this.ctx
      if (!ctx) throw new Error('Translation model is not loaded.')
      this.prefilled = null
      this.stopRequested = false
      const trimmed = text.trim()
      const empty: TranslateResult = { text: '', ms: 0, tokens: 0, promptTokens: 0, cachedTokens: 0, promptMs: 0, generateMs: 0, truncated: false }
      if (opts?.isStale?.()) return { ...empty, interrupted: true }
      if (!trimmed) return empty
      this.activeTag = opts?.tag ?? null
      if (source === target) return { ...empty, text: trimmed }
      const selected = this.selectContextForRequest(context)
      const prompt = buildPrompt(trimmed, target, selected, [...referenceTranslations(trimmed, source, target), ...nameReferences(trimmed, this.names, target)])
      // Bound the output: translations expand at most ~1.6x in tokens; allow 3x plus slack.
      const nPredict = Math.min(256, Math.max(32, estimateTokens(trimmed, source) * 3 + 16))
      const started = Date.now()
      let acc = ''
      // Number of sentences handed to onSentence so far. Sentences are identified by
      // position in the cleaned text, which is deterministic for a given prefix, so a
      // sentence is spoken exactly once even when cleanTranslation later revises the
      // text (wrapping quotes, labels, template tokens). An already-spoken sentence is
      // never re-spoken; only sentences beyond the spoken count are emitted.
      let spokenCount = 0
      const emitSentences = (final: boolean) => {
        if (!onSentence) return
        const cleaned = cleanTranslation(acc)
        const { sentences, rest } = splitSentences(cleaned)
        const tail = final ? rest.trim() : ''
        const all = tail ? [...sentences, tail] : sentences
        for (; spokenCount < all.length; spokenCount++) {
          try {
            onSentence(all[spokenCount])
          } catch (e) {
            console.warn('Translator onSentence failed', e)
          }
        }
      }
      const safePartial = (p: string) => {
        try {
          onPartial?.(p)
        } catch (e) {
          console.warn('Translator onPartial failed', e)
        }
      }
      const completion = ctx.completion(
        {
          messages: [{ role: 'user', content: prompt }],
          jinja: true,
          n_predict: nPredict,
          stop: STOP,
          n_threads: opts?.threads,
          ...SAMPLING,
        },
        onPartial || onSentence
          ? (d) => {
              acc += d.token
              safePartial(cleanTranslation(acc))
              emitSentences(false)
            }
          : undefined,
      )
      // Avoid an unhandled rejection if we stop waiting on it after a timeout.
      completion.catch(() => undefined)
      const timeoutMs = opts?.timeoutMs ?? TRANSLATE_TIMEOUT_MS
      let timedOut = false
      let res: NativeCompletionResult | null = await this.withTimeout(completion, timeoutMs, async () => {
        timedOut = true
        console.warn(`[mt] translation exceeded ${timeoutMs}ms, interrupting`)
        await ctx.stopCompletion()
      })
      if (timedOut && res === null) {
        // stopCompletion makes the native side return the partial result promptly;
        // give it a moment, then carry on with what was streamed so far.
        res = await this.withTimeout(completion, STOP_GRACE_MS)
        if (res === null) console.warn('[mt] completion did not return after stopCompletion; using streamed partial text')
      }
      const interrupted = timedOut || this.stopRequested || !!res?.interrupted
      if (res) acc = res.content || res.text || acc
      const out = cleanTranslation(acc)
      // On an explicit stop() the caller has also stopped the speaker; do not speak the tail.
      if (!this.stopRequested) emitSentences(true)
      this.stopRequested = false
      this.activeTag = null
      const t = res?.timings
      console.log(`[mt] ${source}→${target} prompt ${t?.prompt_n ?? '?'} new / ${t?.cache_n ?? res?.tokens_cached ?? '?'} cached tokens, prompt ${Math.round(t?.prompt_ms ?? 0)}ms, gen ${res?.tokens_predicted ?? '?'} tok in ${Math.round(t?.predicted_ms ?? 0)}ms, total ${Date.now() - started}ms${interrupted ? ' (interrupted)' : ''}`)
      return {
        text: out,
        ms: Date.now() - started,
        tokens: res?.tokens_predicted ?? 0,
        promptTokens: t?.prompt_n ?? 0,
        cachedTokens: t?.cache_n ?? res?.tokens_cached ?? 0,
        promptMs: t?.prompt_ms ?? 0,
        generateMs: t?.predicted_ms ?? 0,
        truncated: !!res?.stopped_limit || interrupted,
        interrupted,
      }
    }
    // Serial queue: `run` starts after the previous request settles (fulfilled or
    // rejected), and the chain itself never rejects, so a failure or timeout in
    // one request cannot wedge the next.
    this.pending += 1
    const guarded = () =>
      withCpuTurn(run, 'translation').finally(() => {
        this.activeTag = null
        this.pending -= 1
      })
    const p = this.queue.then(guarded, guarded)
    this.queue = p.catch(() => undefined)
    return p
  }

  /**
   * Read the conversation so far into the prompt cache while nobody is waiting, so the
   * next translation only processes its own new text. Skipped when a translation is
   * queued (that request reads the conversation anyway). Never throws.
   */
  prefill(context: ContextTurn[]): void {
    if (!this.ctx || this.pending > 0 || context.length === 0) return
    const run = async () => {
      const ctx = this.ctx
      if (!ctx || this.pending > 0) return
      const prefix = promptPrefix(this.selectContextForRequest(context))
      if (prefix === this.prefilled) return
      this.prefilled = prefix
      const started = Date.now()
      try {
        const r = await ctx.completion({ messages: [{ role: 'user', content: prefix }], jinja: true, n_predict: 1, ...SAMPLING })
        console.log(`[mt] prefilled the conversation: ${r.timings?.prompt_n ?? '?'} new tokens in ${Date.now() - started}ms`)
      } catch (e) {
        console.warn('[mt] prefill failed', e)
      }
    }
    const guarded = () => withCpuTurn(run, 'idle')
    this.queue = this.queue.then(guarded, guarded).catch(() => undefined)
  }

  /** Apply the append-only window to the caller's history, remembering where it starts. */
  private selectContextForRequest(context: ContextTurn[]): ContextTurn[] {
    const anchor = this.contextAnchor
    const at = context[this.contextStart]
    const anchored = this.contextStart === 0 || (!!anchor && !!at && at.speaker === anchor.speaker && at.language === anchor.language && at.text === anchor.text)
    const { turns, start } = selectContextWindow(context, anchored ? this.contextStart : 0)
    this.contextStart = start
    this.contextAnchor = context[start] ?? null
    return turns
  }

  /** Native throughput benchmark (prompt-processing and generation tokens/s). */
  async bench(pp = 64, tg = 32): Promise<{ pp: number; tg: number } | null> {
    const ctx = this.ctx
    if (!ctx) return null
    const r = await ctx.bench(pp, tg, 1, 2)
    return { pp: r.speedPp, tg: r.speedTg }
  }

  /** Tag of the request currently running, if any. */
  runningTag(): string | null {
    return this.activeTag
  }

  /**
   * Interrupt the running translation (it resolves with the partial text and
   * `interrupted: true`). Queued requests still run; the next `translate()`
   * works normally because llama.rn clears the interrupt flag per request.
   * With a `tag`, only a running request carrying that tag is interrupted.
   */
  async stop(tag?: string): Promise<void> {
    if (tag !== undefined && this.activeTag !== tag) return
    this.stopRequested = true
    try {
      await this.ctx?.stopCompletion()
    } catch {
      /* ignore */
    }
  }
}

export const Translator = new TranslatorImpl()
