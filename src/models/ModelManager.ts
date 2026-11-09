import { Directory, File, Paths } from 'expo-file-system'
import type { DownloadTask } from 'expo-file-system'
import { ALL_MODELS, type ModelFile } from './catalog'
import { errorMessage, formatBytes } from '../util/format'

export type DownloadStatus =
  | { state: 'absent' }
  | { state: 'downloading'; bytes: number; total: number; task: DownloadTask }
  | { state: 'paused'; bytes: number; total: number; task: DownloadTask }
  /** The file has the right size and its SHA-256 is being computed (a few seconds for 1 GB). */
  | { state: 'verifying' }
  | { state: 'ready'; bytes: number }
  | { state: 'error'; message: string }

type Listener = (id: string, status: DownloadStatus) => void

/**
 * Called before a model file is deleted. Engines register one of these so a
 * file that is currently mmapped by llama.cpp / whisper.cpp is unloaded first.
 */
export type UnloadHook = (m: ModelFile) => Promise<void> | void

/** Keep 150 MB of headroom so the OS and the app itself are not starved. */
const STORAGE_HEADROOM = 150 * 1024 * 1024

const VERIFIED_FILE = '.verified.json'

/** One entry per file whose SHA-256 was checked against the catalog. */
interface VerifiedEntry {
  sha256: string
  size: number
  mtime: number | null
}

/**
 * Thrown by `runVerify` when the file could not be hashed (I/O error, unsupported
 * platform). The file is kept on disk so the user can retry verification without
 * downloading again.
 */
class VerificationUnavailableError extends Error {}

function normalizeHex(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

function isAbortError(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') return true
  return /cancel+ed|aborted/i.test(errorMessage(e))
}

function isNetworkError(msg: string): boolean {
  return /network|internet|offline|resolve|timed? ?out|ENOTFOUND|ECONN|connection|host|socket|unreachable/i.test(
    msg,
  )
}

/**
 * Downloads, verifies and deletes model files under the app's document
 * directory. Files are only fetched when the user explicitly asks for them.
 *
 * Invariants:
 * - A model is `ready` only when its file has the catalogued size AND its SHA-256
 *   was verified at least once (recorded in `models/.verified.json`). A file that
 *   merely has the right size (e.g. copied in externally, or left behind by an
 *   old build) is hashed lazily and reported as `verifying` meanwhile.
 * - Every in-flight operation carries an epoch; `cancel()`/`delete()` bump the
 *   epoch so a verification or download that completes afterwards is ignored and
 *   can never resurrect a `ready` state for a file that was removed.
 */
class ModelManagerImpl {
  private dir: Directory | null = null
  private status = new Map<string, DownloadStatus>()
  private listeners = new Set<Listener>()
  private unloadHooks = new Set<UnloadHook>()
  private epochs = new Map<string, number>()
  private controllers = new Map<string, AbortController>()
  private verified: Record<string, VerifiedEntry> = {}
  private storageError: string | null = null

  constructor() {
    try {
      this.dir = new Directory(Paths.document, 'models')
      if (!this.dir.exists) this.dir.create({ intermediates: true, idempotent: true })
    } catch (e) {
      this.dir = null
      this.storageError = `App storage is unavailable: ${errorMessage(e)}`
      console.warn('ModelManager: could not create models directory', e)
    }
    this.verified = this.readVerified()
    for (const m of ALL_MODELS) this.status.set(m.id, this.probe(m))
    // Hash any size-matching file that has never been verified. This runs in the
    // background; the status stays 'verifying' until it finishes.
    for (const m of ALL_MODELS) {
      if (this.getStatus(m.id).state === 'verifying') void this.verifyExisting(m)
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** Register a hook that is awaited before a model file is deleted (see `UnloadHook`). */
  onBeforeDelete(h: UnloadHook): () => void {
    this.unloadHooks.add(h)
    return () => this.unloadHooks.delete(h)
  }

  fileFor(m: ModelFile): File {
    if (!this.dir) throw new Error(this.storageError ?? 'App storage is unavailable.')
    return new File(this.dir, m.fileName)
  }

  /** Absolute path (no file:// scheme, percent-decoded) for native libraries. */
  pathFor(m: ModelFile): string {
    const raw = this.fileFor(m).uri.replace(/^file:\/\//, '')
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  getStatus(id: string): DownloadStatus {
    return this.status.get(id) ?? { state: 'absent' }
  }

  isReady(m: ModelFile): boolean {
    return this.getStatus(m.id).state === 'ready'
  }

  /** Free space in bytes, or +Infinity when the platform cannot tell us. */
  availableDiskSpace(): number {
    try {
      const v = Paths.availableDiskSpace
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : Number.POSITIVE_INFINITY
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }

  /** Re-check what is on disk for every model that is not currently in flight. */
  refresh(): void {
    for (const m of ALL_MODELS) {
      const s = this.getStatus(m.id).state
      if (s === 'downloading' || s === 'paused' || s === 'verifying') continue
      const next = this.probe(m)
      if (next.state !== s) {
        this.set(m.id, next)
        if (next.state === 'verifying') void this.verifyExisting(m)
      }
    }
  }

  // ---------------------------------------------------------------- internals

  private set(id: string, s: DownloadStatus) {
    this.status.set(id, s)
    for (const l of this.listeners) l(id, s)
  }

  private bumpEpoch(id: string): number {
    const next = (this.epochs.get(id) ?? 0) + 1
    this.epochs.set(id, next)
    return next
  }

  private isCurrent(id: string, epoch: number): boolean {
    return (this.epochs.get(id) ?? 0) === epoch
  }

  private verifiedFile(): File | null {
    return this.dir ? new File(this.dir, VERIFIED_FILE) : null
  }

  private readVerified(): Record<string, VerifiedEntry> {
    try {
      const f = this.verifiedFile()
      if (!f || !f.exists) return {}
      const parsed: unknown = JSON.parse(f.textSync())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, VerifiedEntry> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue
        const e = v as Partial<VerifiedEntry>
        if (typeof e.sha256 !== 'string' || typeof e.size !== 'number') continue
        out[k] = { sha256: e.sha256, size: e.size, mtime: typeof e.mtime === 'number' ? e.mtime : null }
      }
      return out
    } catch (e) {
      console.warn('ModelManager: could not read verified map', e)
      return {}
    }
  }

  private writeVerified(): void {
    try {
      const f = this.verifiedFile()
      if (!f) return
      if (!f.exists) f.create()
      f.writeSync(JSON.stringify(this.verified))
    } catch (e) {
      console.warn('ModelManager: could not write verified map', e)
    }
  }

  private markVerified(m: ModelFile, f: File): void {
    this.verified[m.fileName] = { sha256: m.sha256, size: f.size, mtime: f.modificationTime ?? null }
    this.writeVerified()
  }

  private forgetVerified(m: ModelFile): void {
    if (m.fileName in this.verified) {
      delete this.verified[m.fileName]
      this.writeVerified()
    }
  }

  private isRecordedVerified(m: ModelFile, f: File): boolean {
    const e = this.verified[m.fileName]
    if (!e) return false
    if (normalizeHex(e.sha256) !== normalizeHex(m.sha256)) return false
    if (e.size !== f.size) return false
    const mtime = f.modificationTime ?? null
    if (e.mtime != null && mtime != null && e.mtime !== mtime) return false
    return true
  }

  /**
   * Inspect the file on disk without touching the network. Deletes partial or
   * stale files (wrong size) so a truncated model can never be loaded.
   */
  private probe(m: ModelFile): DownloadStatus {
    if (!this.dir) return { state: 'error', message: this.storageError ?? 'App storage is unavailable.' }
    try {
      const f = this.fileFor(m)
      if (!f.exists) return { state: 'absent' }
      const size = f.size
      if (size !== m.sizeBytes) {
        // Wrong size: a truncated or stale file. Remove it so we never load garbage.
        f.delete()
        this.forgetVerified(m)
        return { state: 'absent' }
      }
      if (this.isRecordedVerified(m, f)) return { state: 'ready', bytes: size }
      return { state: 'verifying' }
    } catch (e) {
      return { state: 'error', message: errorMessage(e) }
    }
  }

  /** Hash a size-matching file that is already on disk (startup / external copy). */
  private async verifyExisting(m: ModelFile): Promise<void> {
    const epoch = this.bumpEpoch(m.id)
    try {
      await this.runVerify(m, epoch)
    } catch (e) {
      if (!this.isCurrent(m.id, epoch)) return
      this.set(m.id, { state: 'error', message: errorMessage(e) })
    }
  }

  private deleteQuietly(m: ModelFile): void {
    try {
      const f = this.fileFor(m)
      if (f.exists) f.delete()
    } catch {
      /* ignore */
    }
    this.forgetVerified(m)
  }

  // ---------------------------------------------------------------- public API

  /** Returns an error string if the download cannot start, otherwise null. */
  preflight(m: ModelFile): string | null {
    if (!this.dir) return this.storageError ?? 'App storage is unavailable.'
    const free = this.availableDiskSpace()
    if (!Number.isFinite(free)) return null
    // Bytes that other in-flight downloads still have to write.
    let inFlight = 0
    for (const other of ALL_MODELS) {
      if (other.id === m.id) continue
      const s = this.getStatus(other.id)
      if (s.state === 'downloading' || s.state === 'paused') inFlight += Math.max(0, s.total - s.bytes)
    }
    const needed = m.sizeBytes + inFlight + STORAGE_HEADROOM
    if (free < needed) {
      const extra = inFlight > 0 ? `, ${formatBytes(inFlight)} for downloads in progress` : ''
      return `Not enough storage: this file needs ${formatBytes(m.sizeBytes)} (plus ${formatBytes(STORAGE_HEADROOM)} headroom${extra}) but only ${formatBytes(free)} is free.`
    }
    return null
  }

  /**
   * Start (or resume) fetching a model. Resolves when the file is verified and
   * `ready`, resolves early when the user pauses or cancels, and rejects when the
   * download or verification fails (the status carries the message).
   */
  async download(m: ModelFile): Promise<void> {
    const current = this.getStatus(m.id)
    if (current.state === 'downloading' || current.state === 'verifying' || current.state === 'ready') return
    if (current.state === 'paused') return this.resume(m)
    if (!this.dir) {
      const message = this.storageError ?? 'App storage is unavailable.'
      this.set(m.id, { state: 'error', message })
      throw new Error(message)
    }

    const dest = this.fileFor(m)

    // Already present with the right size (copied in externally, or a previous
    // verification could not run): hash it instead of downloading again.
    let presentAndComplete = false
    try {
      presentAndComplete = dest.exists && dest.size === m.sizeBytes
    } catch {
      presentAndComplete = false
    }
    if (presentAndComplete) {
      const epoch = this.bumpEpoch(m.id)
      try {
        await this.runVerify(m, epoch)
        return
      } catch (e) {
        if (!this.isCurrent(m.id, epoch)) return
        if (e instanceof VerificationUnavailableError) {
          this.set(m.id, { state: 'error', message: errorMessage(e) })
          throw e
        }
        // Size matched but the hash did not: the file was deleted by runVerify.
        // Fall through and download a fresh copy.
      }
    }

    const blocker = this.preflight(m)
    if (blocker) {
      this.set(m.id, { state: 'error', message: blocker })
      throw new Error(blocker)
    }

    // Remove any leftover partial file (Android writes straight to the destination).
    this.deleteQuietly(m)

    const epoch = this.bumpEpoch(m.id)
    const controller = new AbortController()
    this.controllers.set(m.id, controller)
    const task = File.createDownloadTask(m.url, dest, {
      signal: controller.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (!this.isCurrent(m.id, epoch)) return
        const s = this.getStatus(m.id)
        if (s.state === 'downloading') {
          this.set(m.id, {
            state: 'downloading',
            bytes: bytesWritten,
            total: totalBytes > 0 ? totalBytes : m.sizeBytes,
            task,
          })
        }
      },
    })
    this.set(m.id, { state: 'downloading', bytes: 0, total: m.sizeBytes, task })
    await this.runTask(m, epoch, task, () => task.downloadAsync())
  }

  /**
   * Await a download/resume operation and route its outcome into the status map.
   * Rejects on failure (after setting the `error` status) so callers can react.
   */
  private async runTask(
    m: ModelFile,
    epoch: number,
    task: DownloadTask,
    op: () => Promise<File | null>,
  ): Promise<void> {
    try {
      const file = await op()
      if (!this.isCurrent(m.id, epoch)) return // cancelled or deleted meanwhile
      if (!file) {
        // Paused. `pause()` normally sets the status first; cover a direct task.pause().
        const s = this.getStatus(m.id)
        if (s.state === 'downloading') {
          this.set(m.id, { state: 'paused', bytes: s.bytes, total: s.total, task })
        }
        return
      }
      this.controllers.delete(m.id)
      await this.runVerify(m, epoch)
    } catch (e) {
      if (!this.isCurrent(m.id, epoch)) return // cancel() already set the final status
      this.controllers.delete(m.id)
      if (isAbortError(e)) {
        this.deleteQuietly(m)
        this.set(m.id, { state: 'absent' })
        return
      }
      if (!(e instanceof VerificationUnavailableError)) this.deleteQuietly(m)
      const msg = errorMessage(e)
      this.set(m.id, {
        state: 'error',
        message: isNetworkError(msg)
          ? `Download interrupted (${msg}). Check your connection and try again.`
          : msg,
      })
      throw e
    }
  }

  async pause(m: ModelFile): Promise<void> {
    const s = this.getStatus(m.id)
    if (s.state !== 'downloading') return
    if (s.task.state !== 'active') return // already finished or failed; runTask will settle it
    this.set(m.id, { state: 'paused', bytes: s.bytes, total: s.total, task: s.task })
    try {
      await s.task.pauseAsync()
    } catch (e) {
      // pause() refused (e.g. the transfer completed in the meantime). Put the
      // status back; the pending runTask() decides the final state.
      const now = this.getStatus(m.id)
      if (now.state === 'paused' && now.task === s.task) {
        this.set(m.id, { state: 'downloading', bytes: now.bytes, total: now.total, task: s.task })
      }
      console.warn('ModelManager: pause failed', e)
    }
  }

  async resume(m: ModelFile): Promise<void> {
    const s = this.getStatus(m.id)
    if (s.state !== 'paused') return
    const epoch = this.epochs.get(m.id) ?? 0
    this.set(m.id, { state: 'downloading', bytes: s.bytes, total: s.total, task: s.task })
    try {
      await this.runTask(m, epoch, s.task, () => s.task.resumeAsync())
    } catch (e) {
      if (!this.isCurrent(m.id, epoch)) return
      // iOS produces no resume data when the download was paused before the first
      // byte arrived; the task is unusable, so start over from scratch.
      if (/resume data/i.test(errorMessage(e))) {
        this.set(m.id, { state: 'absent' })
        await this.download(m).catch(() => undefined)
      }
      // Other failures: status is already 'error' (set by runTask).
    }
  }

  /** Abort an in-flight download or verification and remove whatever is on disk. */
  cancel(m: ModelFile): void {
    this.bumpEpoch(m.id)
    const s = this.getStatus(m.id)
    const controller = this.controllers.get(m.id)
    this.controllers.delete(m.id)
    if (s.state === 'downloading' || s.state === 'paused') {
      try {
        controller?.abort()
      } catch {
        /* ignore */
      }
      try {
        // Works from 'active' and 'paused'; a no-op once the task is terminal.
        s.task.cancel()
      } catch {
        /* ignore */
      }
    }
    this.deleteQuietly(m)
    this.set(m.id, this.dir ? { state: 'absent' } : { state: 'error', message: this.storageError ?? 'App storage is unavailable.' })
  }

  /**
   * Verify size and SHA-256 of the file on disk and mark it `ready`. Throws on any
   * problem; the file is deleted on size/hash mismatch but kept when hashing itself
   * was impossible (see `VerificationUnavailableError`).
   */
  private async runVerify(m: ModelFile, epoch: number): Promise<void> {
    this.set(m.id, { state: 'verifying' })
    const f = this.fileFor(m)
    if (!f.exists) throw new Error('Downloaded file is missing.')
    const size = f.size
    if (size !== m.sizeBytes) {
      this.deleteQuietly(m)
      throw new Error(
        `Downloaded file is incomplete (${formatBytes(size)} of ${formatBytes(m.sizeBytes)}). Please try again.`,
      )
    }
    // Digest the whole file (streamed natively in 64 KB chunks; a few seconds for 1 GB).
    // Both platforms return lower-case hex; normalise anyway.
    let digest: string
    try {
      digest = await f.digest('SHA-256')
    } catch (e) {
      throw new VerificationUnavailableError(
        `Could not verify the file (${errorMessage(e)}). Tap Download to retry verification.`,
      )
    }
    if (!this.isCurrent(m.id, epoch)) return // cancelled while hashing; cancel() owns the status
    if (normalizeHex(digest) !== normalizeHex(m.sha256)) {
      this.deleteQuietly(m)
      throw new Error('Downloaded file failed integrity check (SHA-256 mismatch). Please try again.')
    }
    if (!f.exists || f.size !== m.sizeBytes) {
      // Deleted or replaced while we were hashing.
      this.deleteQuietly(m)
      throw new Error('File changed while it was being verified. Please try again.')
    }
    this.markVerified(m, f)
    this.set(m.id, { state: 'ready', bytes: size })
  }

  /**
   * Delete a model file. Engines that have it loaded are asked to unload first
   * (see `onBeforeDelete`); on POSIX the unlinked mapping stays valid until they
   * do, so an engine that ignores the hook keeps working until its next load.
   */
  async delete(m: ModelFile): Promise<void> {
    this.bumpEpoch(m.id) // stop any verification from publishing 'ready' meanwhile
    for (const h of this.unloadHooks) {
      try {
        await h(m)
      } catch (e) {
        console.warn('ModelManager: unload hook failed', e)
      }
    }
    this.cancel(m)
  }

  async deleteAll(): Promise<void> {
    for (const m of ALL_MODELS) await this.delete(m)
  }

  totalOnDisk(): number {
    let total = 0
    for (const m of ALL_MODELS) {
      const s = this.getStatus(m.id)
      if (s.state === 'ready') total += s.bytes
      else if (s.state === 'verifying') total += m.sizeBytes
      else if (s.state === 'downloading' || s.state === 'paused') total += s.bytes
    }
    return total
  }
}

export const ModelManager = new ModelManagerImpl()
