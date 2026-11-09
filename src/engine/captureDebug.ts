import { File, Paths } from 'expo-file-system'
import { pcm16ToWav } from './GroqAsr'

/** One piece boundary chosen by continuous capture (absolute sample positions). */
export type CaptureCut = {
  reason: 'pause' | 'long-gap' | 'long-quiet' | 'end'
  from: number
  at: number
  speechMs: number
  lagMs: number
  dropped: boolean
}

/**
 * Development builds only: write the last continuous capture and its cut points to the
 * app cache (overwritten each time) so segmentation can be checked offline. Release
 * builds never call this, so no audio is stored.
 */
export function writeCaptureDebug(chunks: Int16Array[], cuts: CaptureCut[]) {
  if (!__DEV__) return
  try {
    let total = 0
    for (const c of chunks) total += c.length
    const all = new Int16Array(total)
    let o = 0
    for (const c of chunks) {
      all.set(c, o)
      o += c.length
    }
    const wav = new File(Paths.cache, 'capture-debug.wav')
    wav.create({ overwrite: true })
    wav.write(pcm16ToWav(all, 16000))
    const json = new File(Paths.cache, 'capture-debug.json')
    json.create({ overwrite: true })
    json.write(JSON.stringify({ sampleRate: 16000, samples: total, cuts }))
    console.log(`[seg] debug capture written: ${(total / 16000).toFixed(1)}s, ${cuts.length} cuts`)
  } catch (e) {
    console.warn('[seg] could not write the debug capture', e)
  }
}
