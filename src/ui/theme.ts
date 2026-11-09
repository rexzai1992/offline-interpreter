export const colors = {
  bg: '#0B1016',
  surface: '#141B24',
  surface2: '#1C2531',
  border: '#263241',
  text: '#EEF2F6',
  muted: '#9AA7B6',
  /** Lowest-emphasis text. Kept at >= 4.5:1 on `surface` so 11-12 px captions stay readable. */
  faint: '#8290A0',
  a: '#4F8CFF',
  aDim: '#1F2F4D',
  b: '#2ECC9A',
  bDim: '#17362D',
  danger: '#F06A6A',
  warn: '#E8B94C',
  ok: '#2ECC9A',
  /** Text drawn on top of a filled accent (a / b / danger) button. */
  onAccent: '#0B1016',
}

export const radius = { sm: 8, md: 12, lg: 16, xl: 22 }
export const space = (n: number) => n * 4
/** Minimum touch target (Material / HIG). */
export const TOUCH = 44
