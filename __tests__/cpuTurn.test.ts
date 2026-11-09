import { describe, expect, it } from '@jest/globals'
import { asSpeech, withCpuTurn } from '../src/engine/cpuTurn'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('withCpuTurn', () => {
  it('runs one job at a time and lets speech recognition jump ahead of waiting translations', async () => {
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const job = (name: string) => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      order.push(name)
      await tick()
      active--
    }
    const all = [
      withCpuTurn(job('mt1'), 'translation'),
      withCpuTurn(job('prefill'), 'idle'),
      withCpuTurn(job('mt2'), 'translation'),
      withCpuTurn(job('asr'), 'speech'),
    ]
    await Promise.all(all)
    expect(maxActive).toBe(1)
    // mt1 was already running; then speech, then translations in order, then the idle job.
    expect(order).toEqual(['mt1', 'asr', 'mt2', 'prefill'])
  })

  it('holds idle work while SenseVoice recognises, but not translations', async () => {
    const order: string[] = []
    let finishSpeech: () => void = () => undefined
    const speech = asSpeech(
      () =>
        new Promise<void>((r) => {
          order.push('sv start')
          finishSpeech = () => {
            order.push('sv end')
            r()
          }
        }),
    )
    const idle = withCpuTurn(async () => {
      order.push('prefill')
    }, 'idle')
    const mt = withCpuTurn(async () => {
      order.push('mt')
    }, 'translation')
    await tick()
    expect(order).toEqual(['sv start', 'mt'])
    finishSpeech()
    await Promise.all([speech, idle, mt])
    expect(order).toEqual(['sv start', 'mt', 'sv end', 'prefill'])
  })

  it('keeps going after a job fails', async () => {
    await expect(withCpuTurn(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(withCpuTurn(async () => 42)).resolves.toBe(42)
  })
})
