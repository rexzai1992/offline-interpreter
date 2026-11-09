export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i >= 2 ? 2 : 0)} ${units[i]}`
}

/** Human-readable message for anything that was thrown (Error, string, native CodedError, plain object). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || 'Unknown error'
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; code?: unknown }
    if (typeof o.message === 'string' && o.message) return o.message
    if (typeof o.code === 'string' && o.code) return o.code
  }
  try {
    const s = JSON.stringify(e)
    return s === undefined ? String(e) : s
  } catch {
    return String(e)
  }
}
