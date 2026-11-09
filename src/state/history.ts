import { Directory, File, Paths } from 'expo-file-system'
import type { Turn } from './types'

/**
 * Optional, local-only conversation history. It is only written when the user
 * has enabled "Save conversations" in settings, lives in the app's private
 * document directory, and can be wiped with one tap.
 *
 * All writes and deletes go through one promise chain so two appends (or an
 * append racing a delete) can never interleave and corrupt the JSON file, and
 * each write lands in a temporary file that is then moved over the real one so
 * a crash mid-write leaves the previous history intact.
 */
const FILE_NAME = 'conversations.json'
const TMP_NAME = 'conversations.json.tmp'

let dirCache: Directory | null | undefined

function dir(): Directory | null {
  if (dirCache !== undefined) return dirCache
  try {
    dirCache = new Directory(Paths.document, 'history')
  } catch (e) {
    console.warn('history: document directory unavailable', e)
    dirCache = null
  }
  return dirCache
}

function file(): File | null {
  const d = dir()
  return d ? new File(d, FILE_NAME) : null
}

function tmpFile(): File | null {
  const d = dir()
  return d ? new File(d, TMP_NAME) : null
}

/** Serialises every mutation of the history file. */
let queue: Promise<void> = Promise.resolve()

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export interface SavedConversation {
  id: string
  startedAt: number
  turns: Turn[]
}

function isSavedConversation(v: unknown): v is SavedConversation {
  if (!v || typeof v !== 'object') return false
  const c = v as Partial<SavedConversation>
  return typeof c.id === 'string' && typeof c.startedAt === 'number' && Array.isArray(c.turns)
}

async function readUnlocked(): Promise<SavedConversation[]> {
  try {
    const f = file()
    if (!f || !f.exists) return []
    const parsed: unknown = JSON.parse(await f.text())
    return Array.isArray(parsed) ? parsed.filter(isSavedConversation) : []
  } catch {
    return []
  }
}

export function readHistory(): Promise<SavedConversation[]> {
  // Wait for pending writes so a read never sees a half-written file.
  return enqueue(readUnlocked)
}

async function writeAtomic(all: SavedConversation[]): Promise<void> {
  const d = dir()
  const f = file()
  const tmp = tmpFile()
  if (!d || !f || !tmp) throw new Error('document directory unavailable')
  if (!d.exists) d.create({ intermediates: true, idempotent: true })
  const json = JSON.stringify(all)
  try {
    if (tmp.exists) tmp.delete()
    tmp.create()
    await tmp.write(json)
    await tmp.move(f, { overwrite: true })
  } catch (e) {
    // Fall back to an in-place write (still serialised by the queue).
    console.warn('history: atomic write failed, writing in place', e)
    try {
      if (tmp.exists) tmp.delete()
    } catch {
      /* ignore */
    }
    if (!f.exists) f.create()
    await f.write(json)
  }
}

export function appendConversation(c: SavedConversation): Promise<void> {
  return enqueue(async () => {
    try {
      const all = await readUnlocked()
      const idx = all.findIndex((x) => x.id === c.id)
      if (idx >= 0) all[idx] = c
      else all.push(c)
      await writeAtomic(all)
    } catch (e) {
      console.warn('history write failed', e)
    }
  })
}

/**
 * Remove all saved conversations. Safe to call when nothing was ever saved or
 * the history directory does not exist; pending appends are flushed first so
 * they cannot re-create the file afterwards.
 */
export function deleteHistory(): Promise<void> {
  return enqueue(async () => {
    for (const f of [file(), tmpFile()]) {
      try {
        if (f && f.exists) f.delete()
      } catch (e) {
        console.warn('history delete failed', e)
      }
    }
  })
}

export function historySizeBytes(): number {
  try {
    const f = file()
    return f && f.exists ? f.size : 0
  } catch {
    return 0
  }
}
