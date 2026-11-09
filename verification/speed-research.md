# Latency research (10 parallel research agents, 2026-11-08) and what was applied

Goal: translation visible/spoken 1–2 s after the speaker stops, on ordinary
phones, with the same models (Hy-MT2-1.8B Q4_K_M, whisper.cpp) and no cloud.
Primary test phone: Infinix X6871 (MediaTek Dimensity, 4 big + 4 little
cores, dotprod but no i8mm, no Qualcomm GPU/NPU, 12 GB).

## Findings by area

### 1. llama.cpp CPU path (Android, MediaTek)
* llama.rn 0.12.9 ships prebuilt variants per CPU feature and picks
  `librnllama_v8_2_dotprod.so` on this phone; online repack of Q4_K/Q6_K for
  dotprod is included (llama.cpp PR #17494: +1.5–1.9× prompt processing).
  KleidiAI is not compiled in; building from source would be needed to try it.
* llama.rn pins the N fastest cores and defaults to 4 threads. More than 4
  threads pulls in little cores and collapses throughput (issue #21763).
* KV cache stays f16 (quantised KV slows CPU prompt processing);
  `flash_attn_type: 'auto'`.
* **KV prefix reuse is automatic**: `completion()` reuses the longest common
  token prefix with the previous request and only evaluates the changed tail.
  There is no flag. A sliding context window breaks this; an append-only
  history keeps it.
* Vulkan on Mali: unstable, not built by llama.rn; MediaTek NPU: no ggml
  backend. CPU-only is the realistic path on MediaTek. Qualcomm phones get
  OpenCL (Q4_K is accelerated now) and, on 8 Gen 2+, the Hexagon NPU (needs a
  Q4_0/Q8_0 file). iPhones use Metal (expected 20–45 tok/s for this model).

### 2. Hy-MT2 model options
* 2-bit and 1.25-bit GGUFs need unmerged kernels (PR #19357 SME2-only; PR
  #22836 STQ1_0, open since May 2026, type-id churn, no Metal). On a Dimensity
  8300 STQ1_0 decoded 27 vs 22 tok/s but prefill fell from 79 to 41 tok/s.
  Not adopted.
* No MTP/draft model. N-gram speculative decoding exists in llama.cpp master
  but is not exposed by llama.rn.
* EOS 120020 stops generation correctly; the "special_eos_id is not in
  special_eog_ids" warning is harmless. Extra stop strings added.
* Tencent's quality table: Q4_K_M loses ~1 point vs BF16 on FLORES; 2-bit
  loses ~1.4 more and 2–4.5 on domain/instruction benchmarks.

### 3. Prompt layout (own A/B on desktop, llama-server, 8 pairs × 3 turns)
* Current layout (background block first, instruction, utterance last)
  already keeps the growing history as a shared prefix. A "static header +
  tail instruction" layout and a system-prompt chat layout both reduced
  quality (wrong line translated, source echoed), so the layout is kept.
* Only the sliding window (`slice(-6)`) broke caching. Replaced with an
  append-only budget (~1100 tokens, then reset to the last 2 turns; chat-MT
  research shows 2 turns capture most of the gain).
* Token cost per character for this tokenizer: en 0.23, ms 0.30, tl 0.33,
  zh 0.54, ja 0.76, zh-Hant 0.88 → used to bound `n_predict` (3× source + 16).

### 4. whisper.cpp
* Temperature fallback can run up to 6 extra decoder passes; `bestOf` 5 on
  retries. Set `temperatureInc: 0`, `bestOf: 1`, greedy. Forced language
  avoids an extra language-ID decode.
* `audio_ctx` reduction (encoder on 10–15 s instead of 30 s) gives ~2–3×
  encoder speed but whisper.rn 0.7.4 does not expose it for Whisper (only
  Parakeet). Requires a one-line native patch and a from-source build; not
  applied.
* Android whisper.rn 0.7.4 is CPU-only; iOS: Core ML encoder needs
  `useGpu: false` (otherwise Core ML is disabled). Not yet verified on iOS.
* Whisper paper FLEURS error rates: small/large — Malay 18.9/8.7, Tagalog
  27.7/13.8, Japanese 9.8/4.0, Chinese 20.8/14.7. `base` is unusable for
  ms/tl. Route small for en/ja/zh, turbo for ms/tl when RAM allows.

### 5. Alternative recognisers (not adopted yet)
* sherpa-onnx SenseVoice (zh/en/ja/ko/yue, RTF ≈0.1 on A76 cores) and
  streaming Zipformer (8 languages incl. ja/zh/en) are much faster than
  Whisper but cover no Malay/Tagalog. Omnilingual-ASR 300M CTC (292 MB)
  covers all five incl. ms/tl; Dolphin covers ms/tl but not English.
* A third-party RN binding (`react-native-sherpa-onnx`) exists. This would be
  the next big latency step but is a second ASR stack; deferred.

### 6. End-of-turn and capture
* Production voice stacks endpoint at 300–600 ms of silence; we moved from
  900 to 600 ms, run the VAD on every 64 ms chunk (was ~250 ms over a 1.5 s
  window) and shrink the look-back to one chunk. Semantic end-of-turn: if the
  provisional transcript already ends a sentence, finish after 350 ms.
* Capture buffer 2048 bytes (64 ms). `VOICE_RECOGNITION` source keeps AGC/NS
  off per the Android CDD.
* Keep one audio session (play-and-record) for the whole conversation; never
  toggle recording mode between turns (route changes cost 0.3–0.5 s).

### 7. Speech output
* Both platforms queue utterances; enqueue each sentence as the translation
  streams so time-to-first-audio is one sentence, not the whole translation.
* First utterance per language costs 0.5–2 s (engine bind / voice load):
  pre-warm each selected language with a silent phrase at launch.
* No commercially licensed offline neural TTS exists for Malay or Filipino
  (MMS-TTS is CC-BY-NC); platform voices remain the right choice.

### 8. Pipeline / threads
* Never run ASR and MT with more combined threads than big cores. Final ASR
  4 threads; provisional ASR 2; MT 4 (3 in fast mode while the mic path runs).
* Warm-up both engines after load (empty decode pre-faults mmap pages).
* `use_mlock: true` keeps weights resident; release contexts in background.

### 9. Simultaneous translation
* Literature (LocalAgreement, re-translation with mask-k/biased decoding,
  self-speculative biased decoding) and commercial products (Google, Apple,
  Samsung, DeepL Voice, Timekettle) are segment- or clause-based with 1–5 s
  lag; Japanese is consistently the hardest (verb/negation last).
* Implemented "fast mode": continuous listening, chunk at ~450 ms pauses,
  translate each chunk with the earlier chunks as context, text only.

## Applied changes (this commit)
1. Append-only translation context with token budget (keeps KV prefix cache).
2. `n_predict` bound from source length; extra stop strings; warm-up run;
   `use_mlock`; cache statistics shown in the status line.
3. Sentence-by-sentence speech output while the translation streams.
4. Endpointing 600 ms, per-chunk VAD, semantic end-of-turn, 64 ms buffers.
5. Single-pass Whisper decoding; whisper warm-up; 4/2 thread split.
6. TTS pre-warm per selected language; fixed audio session.
7. Fast mode and hands-free ping-pong options.

## Not applied (and why)
* 1.25-bit / 2-bit Hy-MT2: unmerged kernels, slower prefill, unknown quality.
* `audio_ctx` for Whisper: needs a native patch + source build of whisper.rn.
* sherpa-onnx engines: large architectural change; revisit if Whisper latency
  on target phones is still too high after measurement.
* Vulkan/NPU on MediaTek: no stable backend.
