// @vitest-environment jsdom
/** Playback queue, stop teardown, level metering, routing, and idle lifecycle. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlayback, listOutputDevices, type PlaybackState } from '../src/client/audio/playback.ts'
import { flush, installPlaybackAudio, wav } from './playback-fixture.client.ts'

/**
 * Await a rejection as an `Error` so its name, message, and cause can be asserted without casts.
 * @param promise - promise expected to reject.
 * @returns the rejection.
 */
async function rejection(promise: Promise<void>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error('non-Error rejection', { cause: error })
  }
  throw new Error('expected the promise to reject')
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ordered playback', () => {
  it('plays chunks back to back in arrival order', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    const first = wav(0.25)
    playback.enqueue({ id: 'a', wav: first })
    playback.enqueue({ id: 'b', wav: wav(0.5) })
    await flush()

    expect(audio.createBufferSourceCount()).toBe(2)
    expect(audio.startTimes()).toEqual([0, 0.25])
    expect(playback.state).toEqual({ playing: true, queued: 2, level: 0, deviceId: null })
    expect(audio.context().decodeInputs[0]).not.toBe(first)
    expect(first.byteLength).toBe(250)

    const idle = playback.idle
    let settled = false
    void idle.then(() => { settled = true })
    audio.end(0)
    await flush()
    expect(settled).toBe(false)
    expect(playback.state).toEqual({ playing: true, queued: 1, level: 0, deviceId: null })
    expect(audio.sources()[0]?.disconnect).toHaveBeenCalledTimes(1)

    audio.end(1)
    await expect(idle).resolves.toBeUndefined()
    expect(playback.state).toEqual({ playing: false, queued: 0, level: 0, deviceId: null })
    expect(audio.sources()[1]?.disconnect).toHaveBeenCalledTimes(1)
  })

  it('waits for an earlier chunk before scheduling a later decoded one', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    await playback.setOutputDevice('dev')
    const decode = audio.context().decodeAudioData
    let releaseSlow: (() => void) | undefined
    decode.mockImplementation(async (data: ArrayBuffer) => {
      if (data.byteLength === 250) await new Promise<void>((resolve) => { releaseSlow = resolve })
      return { duration: data.byteLength / 1000 }
    })

    playback.enqueue({ id: 'slow', wav: wav(0.25) })
    playback.enqueue({ id: 'fast', wav: wav(0.5) })
    await flush()
    expect(audio.createBufferSourceCount()).toBe(0)
    expect(playback.state.playing).toBe(false)
    expect(playback.state.queued).toBe(2)

    releaseSlow?.()
    await flush()
    expect(audio.startTimes()).toEqual([0, 0.25])
  })

  it('schedules a chunk that arrives while the previous one is sounding', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    playback.enqueue({ id: 'a', wav: wav(0.5) })
    await flush()
    expect(audio.startTimes()).toEqual([0])
    playback.enqueue({ id: 'b', wav: wav(0.25) })
    await flush()
    expect(audio.startTimes()).toEqual([0, 0.5])
  })

  it('starts at the current time once earlier sources finished', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    await flush()
    audio.end(0)
    await flush()
    audio.context().currentTime = 10
    playback.enqueue({ id: 'b', wav: wav(0.25) })
    await flush()
    expect(audio.startTimes()).toEqual([0, 10])
  })
})

describe('stop', () => {
  it('silences every source synchronously and starts a fresh run afterwards', async () => {
    vi.useFakeTimers()
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    const states: PlaybackState[] = []
    playback.onChange(state => states.push(state))
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    playback.enqueue({ id: 'b', wav: wav(0.5) })
    await flush()
    const sources = audio.sources()
    const idle = playback.idle
    const rejected = vi.fn()
    void idle.catch(rejected)
    audio.context().analyser.signal = 1

    playback.stop()

    // Every scheduling call that silences audio happened in this stack, before any timer ran.
    for (const source of sources) {
      expect(source.stop).toHaveBeenCalledTimes(1)
      expect(source.disconnect).toHaveBeenCalledTimes(1)
    }
    expect(playback.state).toEqual({ playing: false, queued: 0, level: 0, deviceId: null })
    expect(playback.getLevel()).toBe(0)
    // No deferred teardown work remains, so no later scheduling call can keep audio alive.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(149)
    expect(audio.createBufferSourceCount()).toBe(2)
    expect(audio.startTimes()).toEqual([0, 0.25])

    await expect(idle).rejects.toMatchObject({ name: 'AbortError' })
    expect(rejected).toHaveBeenCalledTimes(1)

    playback.stop()
    await flush()
    expect(rejected).toHaveBeenCalledTimes(1)

    playback.enqueue({ id: 'c', wav: wav(0.25) })
    await flush()
    expect(audio.createBufferSourceCount()).toBe(3)
    const nextIdle = playback.idle
    audio.endLast()
    await expect(nextIdle).resolves.toBeUndefined()
    expect(playback.state.playing).toBe(false)
    expect(states.at(-1)).toEqual({ playing: false, queued: 0, level: 0, deviceId: null })
  })

  it('ignores decodes and failures that settle after stop', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    await playback.setOutputDevice('dev')
    let release: (() => void) | undefined
    audio.context().decodeAudioData.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { duration: 0.25 }
    })
    playback.enqueue({ id: 'late-success', wav: wav(0.25) })
    playback.stop()
    release?.()
    await flush()
    expect(audio.createBufferSourceCount()).toBe(0)
    expect(playback.state.queued).toBe(0)

    audio.context().decodeAudioData.mockImplementation(async () => { throw new Error('late failure') })
    playback.enqueue({ id: 'late-failure', wav: wav(0.25) })
    const idle = playback.idle
    playback.stop()
    await flush()
    expect((await rejection(idle)).name).toBe('AbortError')
    expect(audio.createBufferSourceCount()).toBe(0)
  })
})

describe('idle lifecycle', () => {
  it('resolves once after the queue drains and creates a new run on the next enqueue', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    await expect(playback.idle).resolves.toBeUndefined()

    playback.enqueue({ id: 'a', wav: wav(0.25) })
    const first = playback.idle
    const settled = vi.fn()
    void first.then(settled, settled)
    playback.enqueue({ id: 'b', wav: wav(0.25) })
    await flush()
    audio.end(0)
    await flush()
    expect(settled).not.toHaveBeenCalled()
    audio.end(1)
    await expect(first).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledTimes(1)

    playback.enqueue({ id: 'c', wav: wav(0.25) })
    const second = playback.idle
    expect(second).not.toBe(first)
    await flush()
    audio.endLast()
    await expect(second).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('ignores a duplicate end event without settling a second time', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    await flush()
    const source = audio.sources()[0]
    source?.onended?.()
    source?.onended?.()
    await flush()
    expect(playback.state.playing).toBe(false)
    expect(playback.state.queued).toBe(0)
  })
})

describe('malformed WAV', () => {
  it('drops the bad chunk, keeps the queue playing, and reports it when the run drains', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    playback.enqueue({ id: 'first', wav: wav(0.25) })
    playback.enqueue({ id: 'broken', wav: wav(0) })
    playback.enqueue({ id: 'last', wav: wav(0.5) })
    await flush()
    expect(audio.startTimes()).toEqual([0, 0.25])

    const idle = playback.idle
    const settled = vi.fn()
    void idle.then(settled, settled)
    audio.endAll()
    await flush()
    expect(settled).toHaveBeenCalledTimes(1)
    const error = await rejection(idle)
    expect(error.name).toBe('PlaybackChunkError')
    expect(error.message).toContain('broken')
    expect(error.cause).toMatchObject({ message: 'malformed wav' })

    playback.enqueue({ id: 'recovered', wav: wav(0.25) })
    await flush()
    const recovered = playback.idle
    audio.endLast()
    await expect(recovered).resolves.toBeUndefined()
  })

  it('reports the earliest broken chunk when several fail', async () => {
    installPlaybackAudio()
    const playback = createPlayback()
    playback.enqueue({ id: 'bad-a', wav: wav(0) })
    playback.enqueue({ id: 'bad-b', wav: wav(0) })
    await flush()
    expect((await rejection(playback.idle)).message).toContain('bad-a')
  })

  it('reports a decoder that throws synchronously', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    await playback.setOutputDevice('dev')
    audio.context().decodeAudioData.mockImplementation(() => { throw new Error('sync decoder failure') })
    playback.enqueue({ id: 'sync', wav: wav(0.25) })
    const error = await rejection(playback.idle)
    expect(error.name).toBe('PlaybackChunkError')
    expect(error.cause).toMatchObject({ message: 'sync decoder failure' })
    expect(playback.state.playing).toBe(false)
    expect(playback.state.queued).toBe(0)
  })
})

describe('level', () => {
  it('clamps the analyser RMS and samples it at the throttled rate', async () => {
    vi.useFakeTimers()
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    playback.enqueue({ id: 'a', wav: wav(0.5) })
    await flush()
    const meter = audio.context().analyser
    expect(meter.fftSize).toBe(256)

    const levels: number[] = []
    playback.onChange(state => levels.push(state.level))

    meter.signal = 0.5
    expect(playback.getLevel()).toBeCloseTo(0.5)
    await vi.advanceTimersByTimeAsync(50)
    expect(levels.at(-1)).toBeCloseTo(0.5)
    const notified = levels.length
    await vi.advanceTimersByTimeAsync(25)
    expect(levels.length).toBe(notified)

    meter.signal = 2
    expect(playback.getLevel()).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(playback.state.level).toBe(1)

    meter.signal = Number.NaN
    expect(playback.getLevel()).toBe(0)
    await vi.advanceTimersByTimeAsync(50)
    expect(playback.state.level).toBe(0)

    meter.signal = Number.POSITIVE_INFINITY
    expect(playback.getLevel()).toBe(0)

    // Every sample reuses one buffer instead of allocating per frame.
    expect(new Set(meter.buffers).size).toBe(1)
    playback.stop()
  })

  it('reports zero before any output exists', () => {
    installPlaybackAudio()
    const playback = createPlayback()
    expect(playback.getLevel()).toBe(0)
  })
})

describe('output routing', () => {
  it('routes to the requested device and reports the applied id', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    const states: PlaybackState[] = []
    playback.onChange(state => states.push(state))

    await playback.setOutputDevice('dev-a')
    expect(audio.context().setSinkId).toHaveBeenCalledWith('dev-a')
    expect(playback.state.deviceId).toBe('dev-a')
    await playback.setOutputDevice('dev-b')
    expect(playback.state.deviceId).toBe('dev-b')
    expect(states.at(-1)?.deviceId).toBe('dev-b')
    const published = states.length
    await playback.setOutputDevice('dev-b')
    expect(states.length).toBe(published)
    expect(audio.createBufferSourceCount()).toBe(0)
  })

  it('keeps the previous route and rejects when the sink refuses', async () => {
    const playback = createPlayback()
    installPlaybackAudio({ sink: 'fail' })
    const error = await rejection(playback.setOutputDevice('dev-a'))
    expect(error.name).toBe('PlaybackDeviceError')
    expect(error.message).toContain('dev-a')
    expect(error.cause).toMatchObject({ message: 'sink refused' })
    expect(playback.state.deviceId).toBeNull()
  })

  it('reports an environment without setSinkId and still plays through the default output', async () => {
    const audio = installPlaybackAudio({ sink: 'unsupported' })
    const playback = createPlayback()
    const error = await rejection(playback.setOutputDevice('dev-a'))
    expect(error.name).toBe('PlaybackDeviceError')
    expect(error.message).toContain('cannot route')
    expect(playback.state.deviceId).toBeNull()
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    await flush()
    expect(audio.createBufferSourceCount()).toBe(1)
  })

  it('applies the constructor device when the context opens', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback({ deviceId: 'dev-initial' })
    expect(playback.state.deviceId).toBeNull()
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    await flush()
    expect(audio.context().setSinkId).toHaveBeenCalledWith('dev-initial')
    expect(playback.state.deviceId).toBe('dev-initial')
  })

  it('leaves the default reported when the constructor device is refused', async () => {
    installPlaybackAudio({ sink: 'fail' })
    const playback = createPlayback({ deviceId: 'dev-initial' })
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    await flush()
    expect(playback.state.deviceId).toBeNull()
    expect(playback.state.playing).toBe(true)
  })

  it('reports unavailable audio instead of pretending to route', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const playback = createPlayback()
    await expect(playback.setOutputDevice('dev-a')).rejects.toMatchObject({ name: 'PlaybackUnavailableError' })
    expect(playback.state.deviceId).toBeNull()
  })
})

describe('output device listing', () => {
  it('lists only outputs and marks the browser default', async () => {
    installPlaybackAudio()
    const enumerateDevices = vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'mic', label: 'Microphone', groupId: 'g' },
      { kind: 'audiooutput', deviceId: 'default', label: 'System', groupId: 'g' },
      { kind: 'audiooutput', deviceId: 'usb', label: 'USB speakers', groupId: 'u' },
    ])
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices } })
    await expect(listOutputDevices()).resolves.toEqual([
      { id: 'default', label: 'System', isDefault: true },
      { id: 'usb', label: 'USB speakers', isDefault: false },
    ])
  })

  it('marks the first output when the browser reports no explicit default', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audiooutput', deviceId: 'a', label: 'A', groupId: 'a' },
          { kind: 'audiooutput', deviceId: 'b', label: 'B', groupId: 'b' },
        ]),
      },
    })
    await expect(listOutputDevices()).resolves.toEqual([
      { id: 'a', label: 'A', isDefault: true },
      { id: 'b', label: 'B', isDefault: false },
    ])
  })

  it('returns none when the environment cannot enumerate devices', async () => {
    vi.stubGlobal('navigator', {})
    await expect(listOutputDevices()).resolves.toEqual([])
    vi.stubGlobal('navigator', { mediaDevices: {} })
    await expect(listOutputDevices()).resolves.toEqual([])
  })

  it('returns an empty list when there are no outputs', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { enumerateDevices: vi.fn(async () => [{ kind: 'audioinput', deviceId: 'mic', label: 'Mic', groupId: 'm' }]) },
    })
    await expect(listOutputDevices()).resolves.toEqual([])
  })

  it('propagates enumeration failures to the caller', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { enumerateDevices: vi.fn(async () => { throw new Error('permission denied') }) },
    })
    await expect(listOutputDevices()).rejects.toThrow('permission denied')
  })
})

describe('echo reference', () => {
  it('is the single bus every source connects to and survives stop', async () => {
    const audio = installPlaybackAudio()
    const playback = createPlayback()
    expect(playback.createEchoReference()).toBeNull()
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    await flush()
    const reference = playback.createEchoReference()
    expect(reference).toBe(audio.context().gain)
    expect(audio.sources()[0]?.connect).toHaveBeenCalledWith(reference)
    playback.enqueue({ id: 'b', wav: wav(0.25) })
    await flush()
    expect(playback.createEchoReference()).toBe(reference)
    expect(audio.sources()[1]?.connect).toHaveBeenCalledWith(reference)
    playback.stop()
    expect(playback.createEchoReference()).toBe(reference)
  })
})

describe('platform failures', () => {
  it('rejects the chunk when Web Audio is absent', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const playback = createPlayback()
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    expect((await rejection(playback.idle)).name).toBe('PlaybackUnavailableError')
    expect(playback.state).toEqual({ playing: false, queued: 0, level: 0, deviceId: null })
    expect(playback.createEchoReference()).toBeNull()
    playback.stop()
  })

  it('reports a context constructor failure as unavailable with its cause', async () => {
    installPlaybackAudio({ constructs: false })
    const playback = createPlayback()
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    const error = await rejection(playback.idle)
    expect(error.name).toBe('PlaybackUnavailableError')
    expect(error.cause).toMatchObject({ message: 'audio context unavailable' })
  })

  it('resumes a suspended context and ignores a refused resume', async () => {
    const audio = installPlaybackAudio({ suspended: true })
    const playback = createPlayback()
    playback.enqueue({ id: 'a', wav: wav(0.25) })
    await flush()
    expect(audio.context().resume).toHaveBeenCalledTimes(1)
    playback.stop()

    vi.unstubAllGlobals()
    const refused = installPlaybackAudio({ suspended: true, resumeFails: true })
    const second = createPlayback()
    second.enqueue({ id: 'b', wav: wav(0.25) })
    await flush()
    expect(refused.context().resume).toHaveBeenCalledTimes(1)
    expect(second.state.playing).toBe(true)
    second.stop()
  })
})

describe('subscriptions', () => {
  it('isolates a throwing subscriber and stops on unsubscribe', async () => {
    installPlaybackAudio()
    const playback = createPlayback()
    const second = vi.fn()
    playback.onChange(() => { throw new Error('subscriber failure') })
    const unsubscribe = playback.onChange(second)
    expect(() => { playback.enqueue({ id: 'a', wav: wav(0.25) }) }).not.toThrow()
    expect(second).toHaveBeenCalled()
    unsubscribe()
    const before = second.mock.calls.length
    playback.enqueue({ id: 'b', wav: wav(0.25) })
    expect(second).toHaveBeenCalledTimes(before)
    playback.stop()
    expect(playback.state.playing).toBe(false)
  })
})
