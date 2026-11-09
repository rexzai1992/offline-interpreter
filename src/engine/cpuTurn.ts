/**
 * Whisper and the translation model each use every CPU core. Run at the same time on a
 * phone they thrash: in a speaker test a 3 s Malay piece took 7.7 s to recognise instead
 * of about 2.5 s, and the translation running beside it 7.7 s instead of about 1 s.
 * These heavy native jobs take turns here. SenseVoice is light (about 0.15 s per piece) and
 * does not take a turn, so the text of a new piece is not held up by a translation; it is
 * marked with `asSpeech` instead, and optional idle work (prefill, second opinion) does not
 * start while it runs: beside a prefill SenseVoice took 0.5 to 0.8 s in a phone test.
 *
 * Waiting jobs start in priority order, then first come first served. Speech recognition
 * goes before translation, so the text of what was said appears as soon as possible and
 * translations catch up in pauses; the idle prefill goes last. A running job is never
 * interrupted.
 */
export type CpuPriority = 'speech' | 'translation' | 'idle'

const RANK: Record<CpuPriority, number> = { speech: 0, translation: 1, idle: 2 }

interface Waiting {
  rank: number
  seq: number
  start: () => void
}

const waiting: Waiting[] = []
let running = false
let seq = 0
/** Recognition jobs that run outside the turns (SenseVoice), queued or running. */
let speechOutside = 0

function next() {
  if (running || waiting.length === 0) return
  let best = 0
  for (let i = 1; i < waiting.length; i++) {
    const w = waiting[i]
    const b = waiting[best]
    if (w.rank < b.rank || (w.rank === b.rank && w.seq < b.seq)) best = i
  }
  if (waiting[best].rank === RANK.idle && speechOutside > 0) return
  const [job] = waiting.splice(best, 1)
  running = true
  job.start()
}

/**
 * Run recognition that does not take a turn (SenseVoice). Idle jobs wait until it is done;
 * translations may still run beside it.
 */
export async function asSpeech<T>(job: () => Promise<T>): Promise<T> {
  speechOutside += 1
  try {
    return await job()
  } finally {
    speechOutside -= 1
    next()
  }
}

export function withCpuTurn<T>(job: () => Promise<T>, priority: CpuPriority = 'translation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting.push({
      rank: RANK[priority],
      seq: seq++,
      start: () => {
        Promise.resolve()
          .then(job)
          .then(resolve, reject)
          .finally(() => {
            running = false
            next()
          })
      },
    })
    next()
  })
}
