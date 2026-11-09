# Interpreter: on-device two-person conversation translator (Android, iOS)

Two people, two languages, one phone. Each person types, or taps the mic and
speaks, in their own language. The app translates each message naturally with
**Tencent Hy-MT2-1.8B** running locally through **llama.cpp**, and shows the
original and the translation together. Results are shown as **text**; reading
translations aloud is an opt-in setting.

Languages: **English, Malay, Japanese, Mandarin Chinese (Simplified and
Traditional), Filipino/Tagalog**, in any pairing.

Stack: React Native (Expo SDK 58, New Architecture). `llama.rn` embeds
llama.cpp, `whisper.rn` embeds whisper.cpp, and `expo-speech` drives the
platform voices. There was no existing app in the repository, so this stack
was chosen because it embeds llama.cpp natively on both platforms.

---

## Contents

1. [Status: what works and what was tested](#status-what-works-and-what-was-tested)
2. [Measured on a real phone](#measured-on-a-real-phone)
3. [Setup and build](#setup-and-build)
4. [Models: download, size, license](#models-download-size-license)
5. [Privacy, offline behaviour and the optional online voice mode](#privacy-offline-behaviour-and-the-optional-online-voice-mode)
6. [Language pairs and translation quality](#language-pairs-and-translation-quality)
7. [Speech input and output by language](#speech-input-and-output-by-language)
8. [How the translation engine is used](#how-the-translation-engine-is-used)
9. [Known limitations](#known-limitations)
10. [Project layout and tests](#project-layout-and-tests)

---

## Status: what works and what was tested

| Area | Status | Evidence |
|---|---|---|
| Hy-MT2-1.8B Q4_K_M on llama.cpp | **Verified** | The GGUF holds only `f32`/`q4_K`/`q6_K` tensors with architecture and tokenizer `hunyuan-dense` and an embedded chat template. It runs on stock llama.cpp v0.9.0 (desktop) and on llama.rn 0.12.9 (phone). The "STQ kernel" note on the Hugging Face card (llama.cpp PR #22836, unmerged) applies only to the 2-bit and 1.25-bit files. |
| Text translation, all 30 ordered language pairs | **Verified on desktop** with the same model and runtime | `verification/desktop/translation-matrix-results.txt` |
| Text translation on a phone | **Verified** on an Infinix X6871 | [Measured on a real phone](#measured-on-a-real-phone) |
| Translate-while-typing and instant send | **Verified on the phone** | A typed English sentence was previewed in Japanese about 1.2 s after the typing pause; Send committed it in under 0.3 s with no second translation run. |
| On-device speech recognition | **Verified on the phone** | SenseVoice (sherpa-onnx) for Japanese, English and Mandarin: 0.14 to 0.25 s per sentence, auto-detect included. Whisper for Malay and Filipino: 2.4 to 2.9 s. See below. |
| Continuous listening | **Verified with speaker playback on the phone** | Synthetic voices played from a laptop speaker into the phone's microphone: English paragraphs, a 15 s run-on sentence, Japanese and Mandarin, seven English accents, and two-person English/Japanese and Mandarin/English dialogues in tap-to-talk and hands-free mode. Every sentence became its own piece with no words lost at the cuts, and every message landed on the side of the language actually spoken. Real voices in a noisy room were not tested. |
| Optional online speech recognition (Groq) | **Implemented, not yet tested with a real key** | Endpoint and request format checked (HTTP 401 with a dummy key). Needs a user-supplied key. |
| Speech output (platform voices) | **Implemented, not verified by listening** | Off by default. The phone enumerates voices for all six language variants; playback was not checked by ear or in airplane mode. |
| Android build | **Built**: arm64-v8a debug and release APKs | `android/app/build/outputs/apk/` |
| iOS build | **Not built** | The iOS project is generated, but the build machine has no Xcode. |
| Simultaneous interpretation | **Not claimed** | Each message is translated after the speaker pauses, taps stop, or presses Send. |

---

## Measured on a real phone

Device: Infinix X6871, Android 15, MediaTek MT6896, 4 big + 4 little cores
(dotprod, no i8mm), about 11 GB usable RAM, CPU inference (no usable GPU or NPU
path for llama.cpp on MediaTek). Development build, other apps running.

**Translation (Hy-MT2 Q4_K_M)**

| Measure | Result |
|---|---|
| Generation speed | 16 to 19 tokens/s; 9 to 13 tokens/s when the phone was warm after repeated runs |
| Single sentence, no context | 1.2 to 2.8 s end to end |
| Two-way conversation turn, with context | 1.5 to 2.7 s end to end |
| Typed message with preview finished | Under 0.3 s after pressing Send |
| CPU threads 2 to 6 | No meaningful difference; llama.rn pins its 4-thread pool to the big cores at load |
| App memory with translation and Whisper small loaded | About 3.1 GB |

**Prompt order matters on a phone.** Prompt processing runs at roughly 40 to
60 tokens/s here, so re-reading the instructions every turn costs about half
a second. The prompt now puts the fixed instructions first, then the
conversation, then the target language and the new text. Over a 48-turn
desktop test this cut uncached prompt tokens by 37% with equivalent
translations (`verification/desktop/prompt-order-results.txt`). On the phone,
single-sentence prompts dropped from 54 to 67 new tokens to 13 to 33.

**On-device speech recognition**

| Clip of 3 to 5.5 s | Engine | Time on the phone |
|---|---|---|
| Japanese, English, Mandarin, language chosen or auto-detected | SenseVoice Small (sherpa-onnx, CPU) | **0.14 to 0.25 s** |
| Malay, Filipino, language chosen | Whisper small (shorter encoder window) | 2.4 to 2.9 s |
| Malay or Filipino pair, auto-detect | Whisper small | 4.4 to 4.8 s |
| Before today (Whisper small, full window) | | 9.4 to 10.7 s |

How it got there:

1. **SenseVoice for Japanese, English and Mandarin.** FunAudioLLM's SenseVoice
   Small, run with sherpa-onnx 2.0.1 through a small local Expo module
   (`modules/sensevoice`). It matched or beat Whisper on every test clip
   (it fixed a Mandarin clip Whisper kept getting wrong) and identified the
   language correctly every time. It does not support Malay or Filipino.
   The 2025-09-09 conversion is a Cantonese fine-tune that failed on Japanese,
   so the 2024-07-17 model is used.
2. **Whisper with a shorter encoder window** for Malay and Filipino: a 6-line
   patch to whisper.rn (`patches/whisper.rn+0.7.4.patch`) passes whisper.cpp's
   `audio_ctx`, so only the recorded audio is encoded instead of a fixed 30 s.
3. **Whisper base** is used for English and Mandarin only when SenseVoice is
   not installed.
4. **Auto-detect never leaves the selected pair.** In a field test Whisper
   heard English as Malay and wrote the sentence in Malay; now a detection
   outside the pair triggers a second pass in the closer of the two languages.

The phone's NPU cannot be used here: the official sherpa-onnx Android build
targets an old Android API, so its NNAPI path falls back to the CPU (and NNAPI
is deprecated in Android 15). llama.cpp and whisper.cpp have no working GPU or
NPU path on MediaTek phones.

**Continuous listening.** Voice input no longer waits for you to finish. Each
pause of about 0.6 s closes a piece that is recognised and translated while the
microphone keeps recording; a piece longer than 8 s is split at its longest
pause, or at its quietest moment if there is none. Pauses are measured in audio
time, so a busy phone cannot cut a word in half. Tap-to-talk ends after about
2.5 s of silence or a tap; hands-free Voice mode keeps listening. Translations
are text only while the microphone is open. The screen stays on while
listening, and audio is discarded if the app goes to the background.

**Text clean-up.** Recognised text gets a few safe fixes before it is shown:
no stray spaces inside Japanese or Chinese, question marks on clearly worded
English and Mandarin questions ("How much is this bag?"), and English clock
times ("7,45" and "at930" become "7:45" and "at 9:30").

**Faster translations.** As soon as a translation finishes, the conversation so
far is read into the translation model's prompt cache while the next person is
still talking, so the next message only processes its own new text. In speaker
tests this cut prompt processing from about 1.6 s to about 0.9 s per piece.

**Names and special words.** Setup has a list for names the recognisers have
never heard ("Ahmad bin Ismail", "Takeshi = タケシ"). It is given to Whisper as a
spelling hint, used to repair near-misses in recognised text ("Taka she" becomes
"Takeshi"), and passed to the translator so names stay as written. Short names
only replace ordinary words when nearly identical, so "takes" is never turned
into "Takeshi".

**Japanese numbers.** SenseVoice's number formatting sometimes half-converts
Japanese numbers ("三00円" for 三千円, "二五0百円" for 二千五百円). Such pieces are
decoded again with formatting off, which writes them correctly.

**Recognition first.** Whisper and the translation model take turns on the CPU,
and recognition goes first, so the text of what was said appears as soon as
possible and translations catch up in the pauses.

**Start-up.** The app opens on a dark splash with its logo, then an animated
screen that shows the translation model and voice recognition loading, and fades
into the conversation when they are ready (never longer than 25 s).

**Who said it.** A message goes on the side of the language it was spoken in,
whichever microphone button was tapped. When both languages are English,
Japanese or Mandarin, SenseVoice detects the language of every piece for free;
the label is also checked against the script of the text (Japanese characters
labelled English are moved to Japanese, and so on). Strongly accented English
that SenseVoice writes in katakana is recognised again with Whisper. Mandarin
that SenseVoice hears as Cantonese (common with Malaysian and southern accents,
which it then writes as Cantonese words like "食唔系") is recognised again as
Mandarin, and English with a stray Chinese character ("你ha islaysia") is
recognised again as English.

**Voice button.** The large microphone in the middle of the bottom bar starts a
hands-free conversation: both people just talk. While it listens it turns green
with a stop square, and its glow follows the voice.

Raw results: `verification/device/`. The test clips are synthetic speech, so
real voices in noisy places will be somewhat less accurate.

---|---|
| Before (small, full window) | 9.4 to 10.7 s |
| English, Mandarin (base) | 0.76 to 0.95 s |
| Japanese, Malay, Filipino (small) | 2.4 to 2.9 s |
| Auto-detect (small, detects then transcribes) | 4.4 to 4.8 s |
| large-v3-turbo, any language | 21 to 35 s; unsuitable for this phone |

Raw results: `verification/device/asr-model-comparison.txt` and
`verification/device/asr-audioctx-small.txt`. The clips are synthetic speech,
so real voices in noisy places will be somewhat less accurate.

---|---|
| 3 to 5.5 s clip, language chosen | 9.4 to 10.7 s |
| Same clip, language auto-detected | 18 to 21 s (Whisper runs its encoder twice) |
| Reliability | 24 of 24 clips completed after the fixes below |

Whisper always encodes a 30-second window, so short clips are not proportionally
faster. This is why the online Groq option exists, and why auto-detect is off by
default.

---

## Setup and build

Requirements: Node 20+, JDK 17, Android SDK with NDK 27; Xcode 16+ with
CocoaPods for iOS. Native projects are generated with Expo prebuild; do not
edit `android/` or `ios/` by hand.

```bash
npm install
npx expo prebuild

# Android development build (device connected, Metro running)
npx expo run:android

# Self-contained Android release APK
cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a

# iOS (needs Xcode)
npx pod-install
npx expo run:ios --device

# Checks
npx tsc --noEmit
npx jest
```

Notes:

* npm 11 blocks dependency install scripts. `llama.rn` ships its binaries in
  the package; if needed, run
  `node node_modules/llama.rn/install/download-native-artifacts.js`.
  `whisper.rn` 0.7.4 compiles whisper.cpp from source for Android, which takes
  several minutes the first time.
* Build only `arm64-v8a`; 32-bit ABIs cannot hold the model.
* `whisper.rn` is imported as `whisper.rn/index` because its package `exports`
  map has no `"."` entry; `tsconfig.json` maps the types.
* `npm install` also runs `scripts/fetch-sherpa-onnx.mjs`, which downloads the
  official sherpa-onnx 2.0.1 Android library, checks its SHA-256 and extracts
  the Kotlin classes and the two arm64 native libraries into
  `modules/sensevoice/android` (git-ignored). On iOS the SenseVoice module is a
  stub that reports itself unavailable, so iOS keeps using Whisper.
* `npm install` reapplies `patches/whisper.rn+0.7.4.patch` (patch-package,
  `postinstall`). On Android whisper.rn is compiled from source, so the patch
  takes effect. On iOS whisper.rn uses a prebuilt framework, which ignores the
  new option until it is built from source (`RNWHISPER_BUILD_FROM_SOURCE=1`);
  recognition still works there, just without the speed-up.

---

## Models: download, size, license

Nothing is bundled in the APK. The Setup screen downloads each file only after
you confirm. It shows the size and progress, supports pause and resume, checks
free storage first, verifies size and SHA-256, and can delete every file.

| File | Purpose | Size | License |
|---|---|---|---|
| `Hy-MT2-1.8B-Q4_K_M.gguf` (`tencent/Hy-MT2-1.8B-GGUF`) | Translation, required | 1,133,080,448 bytes (1.06 GiB) | Apache-2.0 |
| `ggml-silero-v6.2.0.bin` (`ggml-org/whisper-vad`) | End-of-speech detection, required for voice input | 0.9 MB | MIT |
| `ggml-small-q8_0.bin` (`ggerganov/whisper.cpp`) | On-device speech recognition, recommended | 252 MB | MIT |
| `ggml-base-q8_0.bin` | Fast recognition for English and Mandarin, recommended alongside small | 78 MB | MIT |
| `ggml-large-v3-turbo-q5_0.bin` | Most accurate; too slow for mid-range phones | 547 MB | MIT |
| SenseVoice Small int8 (`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`) | Fast recognition for Japanese, English, Mandarin; recommended | 239 MB + 0.3 MB tokens | FunASR Model License (use and sharing with attribution) |
| `ggml-malaysian-whisper-small-v2-q8_0.bin` (converted from `mesolitica/malaysian-whisper-small-v2`) | Malay recognition, used only while Malay is selected | 264,464,624 bytes | Not stated by Mesolitica; check before commercial release |

Files live in the app's private `models/` directory. Checksums are in
`src/models/catalog.ts`. Speech output uses voices already on the device.

### Malay speech model

Mesolitica's Malaysian Whisper small v2 is Whisper small fine-tuned on Malaysian
speech, including Malaysian English. Measured on the same 150 clips of the FLEURS
Malay test set (real recorded speech), decoded like the app (greedy, no fallback):

| Model | Word error rate | Character error rate | Size |
|---|---|---|---|
| Whisper small (current default) | 21.8% | 6.8% | 252 MB |
| **Malaysian Whisper small v2** | **10.4%** | **3.2%** | 252 MB |
| Malaysian Whisper base | 19.5% | 5.9% | 78 MB |
| Whisper base | 48.7% | 16.0% | 78 MB |

The same test for Filipino (150 FLEURS clips): Whisper small 28.5% word errors,
the community fine-tune `sapinsapin/whisper-small-fsc` 33.3%, so Filipino keeps
Whisper small. Mesolitica's v3 does not work in whisper.cpp yet (an extra
vocabulary token shifts the special tokens; its card also says it is still in
training). Scripts: `verification/asr-eval/`.

The converted file is not hosted anywhere yet, so the Setup screen cannot
download it. To make it downloadable:

1. Convert and quantize (needs Python with `torch` and `transformers`, and a
   whisper.cpp checkout with `mel_filters.npz` from openai/whisper):
   ```bash
   # The checkpoint is bfloat16; re-save it as float32 first.
   python -c "import torch; from transformers import WhisperForConditionalGeneration as W; W.from_pretrained('mesolitica/malaysian-whisper-small-v2', torch_dtype=torch.float32).save_pretrained('mws-fp32')"
   # copy vocab.json, added_tokens.json and the other *.json files from the model repo into mws-fp32/
   python whisper.cpp/models/convert-h5-to-ggml.py mws-fp32 openai-whisper out/
   whisper.cpp/build/bin/whisper-quantize out/ggml-model.bin ggml-malaysian-whisper-small-v2-q8_0.bin q8_0
   ```
2. Check that the result has the size and SHA-256 recorded in `src/models/catalog.ts`.
3. Upload it (for example to your own Hugging Face model repository) and put its
   direct download address in `MALAY_WHISPER_URL` in `src/models/catalog.ts`.

Until then it can be copied onto a test phone over ADB:
```bash
adb push ggml-malaysian-whisper-small-v2-q8_0.bin /data/local/tmp/
adb shell chmod 644 /data/local/tmp/ggml-malaysian-whisper-small-v2-q8_0.bin
adb shell run-as com.craveasia.interpreter cp /data/local/tmp/ggml-malaysian-whisper-small-v2-q8_0.bin files/models/
```
The app checks its SHA-256 on the next start and uses it for Malay.

---

## Privacy, offline behaviour and the optional online voice mode

**Default (fully on-device).** After the model files are installed, the app
uses no network. Translation, speech recognition and end-of-speech detection
run inside the app; speech output, if turned on, uses the on-device system
engine. There is no server, analytics or crash reporter.

* Microphone audio is held in memory as 16 kHz PCM and discarded after
  recognition. The last utterance's audio is kept in memory only so you can
  correct its language and have it re-recognised.
* Recent finished turns are passed to Hy-MT2 as context so names, pronouns and
  tone stay consistent. They live in memory only.
* Nothing is saved by default. "Save conversations on this phone" writes
  finished turns to the app's private storage, and "Delete history" removes
  them.

**Optional online voice input (Groq).** In Setup, "Voice recognition engine"
can be switched to Groq's hosted Whisper large-v3-turbo after an explicit
confirmation. With it on:

* Each recorded utterance is uploaded to Groq for transcription. Typed text and
  all translation stay on the phone.
* You supply your own Groq API key. It is checked against Groq, then stored in
  the app's private storage (AsyncStorage, not encrypted), separate from the
  settings. For a distributed app, put the key behind a small proxy instead of
  on devices.
* If Groq fails or there is no internet, the app falls back to on-device
  Whisper when that model is installed.
* The status line, the Setup status card and the Privacy text all say that
  voice goes to Groq.
* Published price at the time of writing: about $0.04 per audio hour, billed
  per request with a 10-second minimum.

---

## Language pairs and translation quality

All 30 ordered pairs of English, Malay, Japanese, Mandarin (Simplified),
Mandarin (Traditional) and Filipino are supported for text. They were
exercised with three-turn informal conversations in
`verification/desktop/translation-matrix-results.txt`.

* Informal register, particles and names are generally preserved
  ("Thanks ha!", "Ate Liza", "Kak Wang", 「ヤバい」).
* Context works: pronouns and "the one earlier" references resolve when
  previous turns are supplied.
* **Filipino clock times are now handled.** Filipino uses Spanish-derived hours
  (*alas diyes* = ten o'clock, *ala una* = one o'clock, *alas tres y medya* =
  3:30), and Hy-MT2 got them wrong in most samples (7, 12, 19:00, 2 a.m.). The
  app now detects them and passes the correct time through Tencent's
  terminology template ("Reference the following translations: X translates to
  Y"). On desktop this fixed 20 of 20 test cases across five target languages
  (`verification/desktop/glossary-results.txt`).
* Other observed errors: one Japanese to Chinese turn changed 十時 to 十二点.
  *Kedai mamak* was garbled in Japanese and Traditional Chinese. One English to
  Traditional Chinese line came out in Simplified characters. Treat other
  numbers and times as worth confirming.

---

## Speech input and output by language

**Input, on-device (whisper.cpp).** Results on synthetic test clips, desktop and
phone agreeing:

| Language | small-q8_0 | large-v3-turbo-q5_0 | Notes |
|---|---|---|---|
| English | Exact | Exact | |
| Japanese | Exact | Exact | |
| Mandarin | One small error | Exact | Whisper picks Simplified or Traditional script itself; translation accepts either. |
| Malay | Partial errors | Near exact | Auto-detect sometimes says Indonesian; that is mapped to Malay. |
| Tagalog | One of two clips poor | One of two clips poor | Weakest language. The Tagalog clips were synthetic, which may contribute. |

**Output, platform voices (opt-in).** The Infinix lists Google voices for
en-US, ms-MY, ja-JP, zh-CN, zh-TW and fil-PH. The app marks a voice "offline"
only when the engine names it as a local voice; others may need voice data
downloaded in the system Text-to-speech settings. iOS ships voices for English,
Malay, Japanese and Mandarin (mainland and Taiwan) and **no Filipino voice**.
None of this was verified by listening.

---

## How the translation engine is used

* Model: `Hy-MT2-1.8B-Q4_K_M.gguf` through llama.rn, `n_ctx` 2048, memory-mapped
  and locked, warmed up after load. Metal on iOS; on Android, OpenCL (Adreno)
  when present, otherwise CPU.
* No system prompt (the model card says the model has none). The GGUF's own
  chat template is applied by llama.cpp.
* Prompt: Tencent's documented *Style* and *Background Information* templates.
  Order: the fixed instructions ("natural everyday spoken conversation, same
  tone and politeness as the speaker; only output the translated result"),
  then previous turns labelled by speaker and language, then "Please translate
  the following text into {language}" and the text. Target languages use the
  model card's full English names (`Chinese`, `Traditional Chinese`,
  `Filipino`).
* Context is append-only, so llama.cpp's prefix cache can reuse it. When it
  exceeds about 1,100 tokens it restarts from the last two turns.
* Sampling: Tencent's recommendation for 1.8B: temperature 0.7, top-p 0.6,
  top-k 20, repetition penalty 1.05. Output length is capped from the source
  length, and each request has a 20 s timeout.
* **Translate while typing.** About 0.45 s after typing pauses, the draft is
  translated in the background with exactly the prompt the real message would
  use. Pressing Send commits a finished preview instantly or waits for one in
  progress. A newer draft interrupts a stale preview, but a sent message is
  never interrupted.
* Known problem terms get reference translations through Tencent's terminology
  template, placed just before the instruction to translate. Currently this
  covers Filipino clock times.
* Output is trimmed of wrapping quotes, echoed labels and template tokens, and
  otherwise shown verbatim.
* Any translation can be opened full screen in large text, and turned upside
  down for the person across the table.

See `src/engine/Translator.ts` and `src/state/useInterpreter.ts`.

---

## Known limitations

* **Malay and Filipino voice is slower** (about 2.5 to 3 s per piece) because
  SenseVoice does not support them and Whisper is used. Whisper and the
  translation model take turns for the CPU: run together they thrashed, and a
  3 s Malay piece took 7.7 s to recognise instead of 2.5 s.
* **Filipino speech recognition is weak in testing.** The only Filipino test
  voice is a low-quality synthetic one (Meta MMS-TTS), and Whisper small
  garbled much of it. Malay speech from the macOS voice was recognised well.
* **Garbled input can produce a fluent wrong translation.** The translator sees
  the previous messages as context; when the recognised text is nonsense, it can
  borrow a sentence from that context. The app now catches the clearest case (a
  translation that copies an earlier message): it translates again without
  context and shows "The recognised text may be wrong". Other nonsense still
  produces nonsense, so check the original text shown above each translation.
* **SenseVoice writes Mandarin in Simplified characters**, also for
  Traditional speakers. The translation is unaffected.
* **SenseVoice is Android-only for now.** iOS needs the sherpa-onnx
  xcframework, which was not integrated (no Xcode here).
* **Memory**: the translation model needs about 1.4 GB; Whisper small adds
  about 0.5 GB and large-v3-turbo about 1.5 GB. The app refuses to load the
  model below 3 GB of total RAM and warns below 4 GB. Phones with 3 to 4 GB
  were not tested.
* **Only one phone was tested.** No speed is promised for other devices.
* **Not simultaneous.** Voice messages are finalised after about 0.6 s of
  silence (adjustable) or a tap.
* **Turn separation**: listening and playback never overlap, so a spoken
  translation cannot be captured as the other person's reply.
* **Auto-detect** chooses between the two selected languages only. It is
  always on, and free, when both are English, Japanese or Mandarin. For Malay
  and Filipino it is a setting that roughly doubles recognition time and is less
  reliable. The detected language is shown on each message and can be corrected
  with one tap.
* **Hokkien and other Chinese dialects are not understood.** SenseVoice writes
  Hokkien speech with Hokkien characters (阮, 毋, 汝) and the translator guesses.
  The app now marks such messages: "This sounds like Hokkien. The app understands
  Mandarin, so this translation may be wrong." Cantonese is recognised again as
  Mandarin; if Cantonese words remain, the message gets the same warning.
* **Very strong accents** can still fail. In speaker tests, English read by
  the macOS Japanese voice came out as nonsense Japanese, and the translator
  then produced a confident but unrelated sentence. British, Indian,
  Australian, Irish and Malay-accented English were recognised correctly.
* **Names** are often misheard ("Takeshi" as "Taka she", "Kumar" as
  "command", "Ahmad bin Ismail" as "I had been a smile"). Tap edit on the message
  to correct the text; it is translated again.
* **Numbers and times** are the most common translation error.
* **iOS** is unbuilt and untested here.

---

## Project layout and tests

```
App.tsx                         entry; Conversation and Setup screens
src/languages.ts                language table (model names, Whisper codes, voice tags)
src/models/catalog.ts           downloadable files, sizes, SHA-256, licenses
src/models/ModelManager.ts      consent-based download, pause/resume, verify, delete
src/engine/Translator.ts        llama.rn wrapper: prompt, context window, sampling, timeouts
src/engine/SpeechRecognizer.ts  microphone, Silero pause detection, SenseVoice/Whisper routing, language checks
src/engine/captureDebug.ts      development builds only: saves the last capture and its cut points
src/engine/GroqAsr.ts           optional online recognition (Groq)
modules/sensevoice/             local Expo module: SenseVoice via sherpa-onnx (Android)
scripts/fetch-sherpa-onnx.mjs   downloads and verifies the sherpa-onnx Android library
src/engine/Speaker.ts           platform voices, queue, offline heuristic
src/engine/SelfTest.ts          development-only on-device measurements
src/state/useInterpreter.ts     conversation logic: turns, previews, voice loops
src/state/settings.ts           persisted settings and the Groq key
src/state/history.ts            optional local history (off by default)
src/ui/*                        screens and components (Composer is the text input)
__tests__/*                     Jest tests for prompt, cleaning, splitting, WAV, languages
verification/desktop/*          scripts, test audio and raw results of desktop checks
verification/speed-research.md  latency research notes
```

`npx jest` runs 80 tests; `npx tsc --noEmit` typechecks the project;
`npx expo lint` lints it (ESLint was set up by that command on 2026-11-08).
