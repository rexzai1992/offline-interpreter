import { describe, expect, it } from '@jest/globals'

import { errorMessage, formatBytes } from '../src/util/format'

describe('formatBytes', () => {
  it('formats bytes and kilobytes without decimals', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
  })

  it('formats megabytes and gigabytes with two decimals', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.50 MB')
    expect(formatBytes(1133080448)).toBe('1.06 GB')
  })

  it('caps the unit at GB', () => {
    expect(formatBytes(1024 ** 4)).toBe('1024.00 GB')
  })

  it('returns "?" for negative or non-finite input', () => {
    expect(formatBytes(-1)).toBe('?')
    expect(formatBytes(NaN)).toBe('?')
    expect(formatBytes(Infinity)).toBe('?')
  })
})

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type')
  })

  it('returns strings unchanged', () => {
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage('')).toBe('')
  })

  it('prefers a string message or code on thrown plain objects (native CodedError)', () => {
    expect(errorMessage({ message: 'native failure', code: 'E_FAIL' })).toBe('native failure')
    expect(errorMessage({ code: 'E_NO_PERMISSION' })).toBe('E_NO_PERMISSION')
    expect(errorMessage({ message: '', code: 'E_EMPTY' })).toBe('E_EMPTY')
    expect(errorMessage({ message: 42 })).toBe('{"message":42}')
  })

  it('falls back to the name for an Error with an empty message', () => {
    expect(errorMessage(new RangeError(''))).toBe('RangeError')
  })

  it('serialises other objects and primitives as JSON', () => {
    expect(errorMessage({ status: 1 })).toBe('{"status":1}')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
  })

  it('falls back to String() when JSON.stringify throws or yields undefined', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe('[object Object]')
    expect(errorMessage(BigInt(5))).toBe('5')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(() => 1)).toMatch(/^\(\) => 1$/)
    expect(typeof errorMessage(Symbol('s'))).toBe('string')
  })
})
