import { describe, expect, it, jest } from '@jest/globals'

jest.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))

import { normalizeLanguage, pcm16ToWav } from '../src/engine/GroqAsr'

describe('pcm16ToWav', () => {
  it('writes a valid 16 kHz mono PCM16 header and payload', () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768])
    const wav = pcm16ToWav(pcm, 16000)
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    const ascii = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(dv.getUint16(20, true)).toBe(1)
    expect(dv.getUint16(22, true)).toBe(1)
    expect(dv.getUint32(24, true)).toBe(16000)
    expect(dv.getUint32(28, true)).toBe(32000)
    expect(dv.getUint16(34, true)).toBe(16)
    expect(ascii(36, 4)).toBe('data')
    expect(dv.getUint32(40, true)).toBe(pcm.length * 2)
    expect(dv.getUint32(4, true)).toBe(36 + pcm.length * 2)
    expect(wav.byteLength).toBe(44 + pcm.length * 2)
    expect(dv.getInt16(44 + 3 * 2, true)).toBe(32767)
    expect(dv.getInt16(44 + 4 * 2, true)).toBe(-32768)
  })
})

describe('normalizeLanguage', () => {
  it('maps verbose_json language names to whisper codes', () => {
    expect(normalizeLanguage('english')).toBe('en')
    expect(normalizeLanguage('Malay')).toBe('ms')
    expect(normalizeLanguage('japanese')).toBe('ja')
    expect(normalizeLanguage('chinese')).toBe('zh')
    expect(normalizeLanguage('tagalog')).toBe('tl')
    expect(normalizeLanguage('indonesian')).toBe('id')
  })
  it('passes through ISO codes and rejects junk', () => {
    expect(normalizeLanguage('ja')).toBe('ja')
    expect(normalizeLanguage('zh-TW')).toBe('zh')
    expect(normalizeLanguage('')).toBeNull()
    expect(normalizeLanguage(undefined)).toBeNull()
    expect(normalizeLanguage('klingon language')).toBeNull()
  })
})
