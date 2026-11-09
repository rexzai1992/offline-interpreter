package expo.modules.sensevoice

import android.os.SystemClock
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Int16Array
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

private class NotLoadedException : CodedException("ERR_SENSEVOICE_NOT_LOADED", "SenseVoice model is not loaded", null)
private class NoAudioException : CodedException("ERR_SENSEVOICE_NO_AUDIO", "Audio buffer not found (call prepare first)", null)
private class ModelMissingException(path: String) : CodedException("ERR_SENSEVOICE_MODEL_MISSING", "File not found: $path", null)

/**
 * Minimal wrapper around sherpa-onnx's offline recognizer for SenseVoice Small.
 * One recognizer is kept; the language is switched per request through setConfig,
 * which only changes the decoding language (the model is not reloaded).
 * Audio arrives as 16-bit PCM and never leaves memory.
 */
class SenseVoiceModule : Module() {
  private val lock = Any()
  private var recognizer: OfflineRecognizer? = null
  private var config: OfflineRecognizerConfig? = null
  private var provider: String = "cpu"

  /**
   * Audio copied out of JavaScript memory. JS typed arrays may only be read on the JS
   * thread (Hermes is not thread-safe; reading one from the async queue crashed with
   * SIGSEGV), so `prepare` copies synchronously and `transcribe` uses the copy.
   */
  private val buffers = ConcurrentHashMap<Int, FloatArray>()
  private val nextId = AtomicInteger(1)

  override fun definition() = ModuleDefinition {
    Name("SenseVoice")

    Constants("available" to true)

    AsyncFunction("load") { modelPath: String, tokensPath: String, numThreads: Int, requestedProvider: String ->
      if (!File(modelPath).exists()) throw ModelMissingException(modelPath)
      if (!File(tokensPath).exists()) throw ModelMissingException(tokensPath)
      synchronized(lock) {
        recognizer?.release()
        recognizer = null
        config = null
        val started = SystemClock.elapsedRealtime()
        val cfg = OfflineRecognizerConfig(
          featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
          modelConfig = OfflineModelConfig(
            senseVoice = OfflineSenseVoiceModelConfig(model = modelPath, language = "auto", useInverseTextNormalization = true),
            tokens = tokensPath,
            numThreads = numThreads,
            provider = requestedProvider,
            debug = false,
          ),
          decodingMethod = "greedy_search",
        )
        recognizer = OfflineRecognizer(null, cfg)
        config = cfg
        provider = requestedProvider
        mapOf("provider" to requestedProvider, "loadMs" to (SystemClock.elapsedRealtime() - started).toInt())
      }
    }

    // Runs synchronously on the JS thread: the only safe place to read the typed array.
    Function("prepare") { pcm: Int16Array ->
      val bytes = ByteArray(pcm.byteLength)
      pcm.read(bytes, 0, pcm.byteLength)
      val shorts = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      val samples = FloatArray(shorts.remaining()) { i -> shorts.get(i) / 32768f }
      val id = nextId.getAndIncrement()
      buffers[id] = samples
      id
    }

    // useItn: SenseVoice's number formatting ("three thousand" -> "3,000"). On by default; it
    // also adds punctuation. Its Japanese output can mangle numbers ("三00円"), so the caller
    // re-decodes such pieces with it off.
    AsyncFunction("transcribe") { bufferId: Int, sampleRate: Int, language: String, useItn: Boolean ->
      val samples = buffers.remove(bufferId) ?: throw NoAudioException()
      synchronized(lock) {
        val rec = recognizer ?: throw NotLoadedException()
        val cfg = config ?: throw NotLoadedException()
        val sv = cfg.modelConfig.senseVoice
        if (sv.language != language || sv.useInverseTextNormalization != useItn) {
          sv.language = language
          sv.useInverseTextNormalization = useItn
          rec.setConfig(cfg)
        }
        val started = SystemClock.elapsedRealtime()
        val stream = rec.createStream()
        try {
          stream.acceptWaveform(samples, sampleRate)
          rec.decode(stream)
          val r = rec.getResult(stream)
          mapOf(
            "text" to r.text,
            "lang" to r.lang,
            "emotion" to r.emotion,
            "event" to r.event,
            "ms" to (SystemClock.elapsedRealtime() - started).toInt(),
            "provider" to provider,
          )
        } finally {
          stream.release()
        }
      }
    }

    Function("discard") { bufferId: Int ->
      buffers.remove(bufferId)
      Unit
    }

    AsyncFunction("release") {
      synchronized(lock) {
        recognizer?.release()
        recognizer = null
        config = null
      }
      buffers.clear()
    }

    OnDestroy {
      synchronized(lock) {
        recognizer?.release()
        recognizer = null
        config = null
      }
    }
  }
}
