# Desktop verification (macOS, Apple M2, 8 GB)

These scripts and outputs are the record of the checks run before the mobile
integration. They use the *same* model files and inference libraries the app
uses (llama.cpp for Hy-MT2, whisper.cpp for speech), but on the Mac.

## Translation (Hy-MT2-1.8B Q4_K_M, llama.cpp v0.9.0)

* `tr.py` — helper that calls a local `llama-server` (`--jinja`, so the
  GGUF's embedded Hy-MT2 chat template is applied) with Tencent's recommended
  sampling parameters.
* `tr2.py` — prompt-template comparison (official default vs. style template,
  temperature 0.7 vs 0.3).
* `matrix.py` — one three-turn sample conversation per source language
  (informal phrases, names, time references, pronoun references to earlier
  turns) translated into every other language with the previous turns passed
  as background context. 30 ordered pairs, 90 translations.
* `translation-matrix-results.txt` / `.json` — the outputs, unedited, with
  per-request timing on the Mac (Metal).

Run:

```bash
./llama.cpp/build/bin/llama-server --model Hy-MT2-1.8B-Q4_K_M.gguf --jinja -ngl 99 -c 4096 --port 8081
python3 matrix.py
```

## Speech recognition (whisper.cpp v1.9.5)

* `audio/` — 16 kHz mono test clips. English, Japanese, Mandarin
  (Simplified- and Traditional-script sentences), and Malay were synthesised
  with macOS system voices (`say`); Tagalog has no macOS voice, so the two
  Tagalog clips were synthesised with Meta's MMS-TTS `tgl` model
  (`mms_tts.py`). Synthetic speech is cleaner than a real microphone, so these
  are an upper bound on accuracy.
* `whisper-results.txt` — transcriptions with the language forced and with
  auto-detection, for `ggml-small-q8_0` and `ggml-large-v3-turbo-q5_0`.
* `whisper-autodetect.txt` — detected language and probability per clip, and
  timing of both models on one clip.
