/**
 * Downloadable model files. Sizes and SHA-256 digests were recorded from the
 * files actually downloaded and verified during development (see README).
 */
export type ModelKind = 'translation' | 'asr' | 'vad' | 'sensevoice'

export interface ModelFile {
  id: string
  kind: ModelKind
  label: string
  description: string
  fileName: string
  url: string
  /** Exact size in bytes, used for progress, storage checks and integrity. */
  sizeBytes: number
  sha256: string
  license: string
  licenseUrl: string
}

export const HY_MT2_Q4_K_M: ModelFile = {
  id: 'hy-mt2-1.8b-q4_k_m',
  kind: 'translation',
  label: 'Hy-MT2-1.8B (Q4_K_M)',
  description:
    'Tencent Hy-MT2 1.8B translation model, GGUF 4-bit (Q4_K_M). Runs with llama.cpp on-device.',
  fileName: 'Hy-MT2-1.8B-Q4_K_M.gguf',
  url: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf',
  sizeBytes: 1133080448,
  sha256: 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699',
  license: 'Apache-2.0',
  licenseUrl: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/blob/main/LICENSE.txt',
}

export const WHISPER_SMALL_Q8: ModelFile = {
  id: 'whisper-small-q8_0',
  kind: 'asr',
  label: 'Whisper small (q8_0), recommended',
  description:
    'Accurate in all five languages. About 3 s per sentence on a mid-range phone.',
  fileName: 'ggml-small-q8_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin',
  sizeBytes: 264464607,
  sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f',
  license: 'MIT',
  licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
}

export const WHISPER_TURBO_Q5: ModelFile = {
  id: 'whisper-large-v3-turbo-q5_0',
  kind: 'asr',
  label: 'Whisper large-v3-turbo (q5_0), high-end phones only',
  description:
    'Most accurate, but very slow on mid-range phones (over 20 s per sentence measured on a MediaTek phone). Only for high-end phones.',
  fileName: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  sizeBytes: 574041195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  license: 'MIT',
  licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
}

export const WHISPER_BASE_Q8: ModelFile = {
  id: 'whisper-base-q8_0',
  kind: 'asr',
  label: 'Whisper base (q8_0), fast for English and Mandarin',
  description:
    'About 1 s per sentence on a mid-range phone. As accurate as small for English and Mandarin, weaker for Japanese, Malay and Filipino. When installed, it is used automatically for English and Mandarin.',
  fileName: 'ggml-base-q8_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q8_0.bin',
  sizeBytes: 81768585,
  sha256: 'c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9',
  license: 'MIT',
  licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
}

export const SILERO_VAD: ModelFile = {
  id: 'silero-vad-v6.2.0',
  kind: 'vad',
  label: 'Silero VAD v6.2.0',
  description: 'Voice activity detector used for end-of-turn detection.',
  fileName: 'ggml-silero-v6.2.0.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
  sizeBytes: 885098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  license: 'MIT',
  licenseUrl: 'https://github.com/snakers4/silero-vad/blob/master/LICENSE',
}

/**
 * SenseVoice Small (FunAudioLLM), int8 ONNX as converted by sherpa-onnx (2024-07-17
 * release). Used for Japanese, English and Mandarin. The newer 2025-09-09 conversion is a
 * Cantonese fine-tune and failed on Japanese in our tests, so it is not used.
 */
export const SENSEVOICE_MODEL: ModelFile = {
  id: 'sensevoice-small-int8',
  kind: 'sensevoice',
  label: 'SenseVoice Small (Japanese, English, Mandarin)',
  description:
    'Very fast on-device recognition for Japanese, English and Mandarin, with language detection. Malay and Filipino still use Whisper.',
  fileName: 'sensevoice-small-int8.onnx',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
  sizeBytes: 239233841,
  sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
  license: 'FunASR Model License',
  licenseUrl: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
}

/** Token list that goes with SENSEVOICE_MODEL; downloaded together with it. */
export const SENSEVOICE_TOKENS: ModelFile = {
  id: 'sensevoice-small-tokens',
  kind: 'sensevoice',
  label: 'SenseVoice tokens',
  description: 'Vocabulary file for SenseVoice Small.',
  fileName: 'sensevoice-small-tokens.txt',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
  sizeBytes: 315894,
  sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
  license: 'FunASR Model License',
  licenseUrl: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
}

/**
 * Where the converted Malaysian Whisper file is hosted. Empty until it is uploaded (see
 * README, "Malay speech model"); until then it can only be copied onto a phone from a
 * computer, and the Setup screen says so instead of offering a download.
 */
export const MALAY_WHISPER_URL = ''

/**
 * Mesolitica's Malaysian Whisper small v2 (fine-tuned on Malaysian speech, including
 * Malaysian English), converted to whisper.cpp q8_0. On 150 FLEURS Malay test clips it
 * made half the word errors of Whisper small (10.4% vs 21.8%) at the same size and speed.
 * Used only for Malay, and loaded only when Malay is one of the two languages.
 */
export const MALAY_WHISPER_SMALL_Q8: ModelFile = {
  id: 'malaysian-whisper-small-v2-q8_0',
  kind: 'asr',
  label: 'Malaysian Whisper small (Malay)',
  description: 'Malay speech, including Malaysian English. Half the errors of Whisper small on Malay; same speed.',
  fileName: 'ggml-malaysian-whisper-small-v2-q8_0.bin',
  url: MALAY_WHISPER_URL,
  sizeBytes: 264464624,
  sha256: '4b1a3a1ecc737749bffc38724dbfa5f027eea423dc95d64001f84836be68737d',
  license: 'Not stated by Mesolitica',
  licenseUrl: 'https://huggingface.co/mesolitica/malaysian-whisper-small-v2',
}

export const ASR_MODELS: ModelFile[] = [WHISPER_SMALL_Q8, WHISPER_TURBO_Q5, WHISPER_BASE_Q8]
export const ALL_MODELS: ModelFile[] = [HY_MT2_Q4_K_M, ...ASR_MODELS, MALAY_WHISPER_SMALL_Q8, SILERO_VAD, SENSEVOICE_MODEL, SENSEVOICE_TOKENS]

export function modelById(id: string): ModelFile | undefined {
  return ALL_MODELS.find((m) => m.id === id)
}
