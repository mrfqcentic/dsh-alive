/** Deterministic Web Audio devices for playback tests; no hardware is touched. */
import { vi, type Mock } from 'vitest'

/** Decoded buffer the fake decoder reports. */
interface FakeBuffer {
  duration: number
}

/** One scheduled source as the production code sees it. */
export interface FakeSource {
  buffer: unknown
  onended: (() => void) | null
  startedAt: number | null
  ended: boolean
  readonly start: (when: number) => void
  readonly stop: ReturnType<typeof vi.fn>
  readonly connect: ReturnType<typeof vi.fn>
  readonly disconnect: ReturnType<typeof vi.fn>
}

/** Output level meter driven by the test. */
export interface FakeAnalyser {
  fftSize: number
  /** RMS the next read reports, before the analyser's own floating-point noise. */
  signal: number
  /** Every array instance passed to `getFloatTimeDomainData`. */
  readonly buffers: Float32Array[]
  readonly connect: ReturnType<typeof vi.fn>
  readonly disconnect: ReturnType<typeof vi.fn>
  getFloatTimeDomainData(target: Float32Array): void
}

/** Playback bus the sources connect to. */
export interface FakeGain {
  readonly connect: ReturnType<typeof vi.fn>
  readonly disconnect: ReturnType<typeof vi.fn>
}

/** One fake audio context, including the nodes it handed out. */
export interface FakeContext {
  currentTime: number
  state: 'running' | 'suspended'
  readonly destination: object
  setSinkId?: Mock<(sinkId: string) => Promise<void>>
  readonly decodeAudioData: Mock<(data: ArrayBuffer) => Promise<FakeBuffer>>
  /** Every buffer handed to the decoder, in call order. */
  readonly decodeInputs: ArrayBuffer[]
  readonly resume: Mock<() => Promise<void>>
  readonly sources: FakeSource[]
  readonly analyser: FakeAnalyser
  readonly gain: FakeGain
  createGain(): FakeGain
  createAnalyser(): FakeAnalyser
  createBufferSource(): FakeSource
}

/** Controls and observations for one installed fake device set. */
export interface PlaybackAudioFixture {
  readonly contexts: FakeContext[]
  /** Most recently created context; throws before the controller opens audio. */
  context(): FakeContext
  /** Sources created by the most recent context. */
  sources(): FakeSource[]
  createBufferSourceCount(): number
  startTimes(): number[]
  /** End one source by creation index, as the audio clock would. */
  end(index: number): void
  /** End the most recent source that has not ended yet. */
  endLast(): void
  /** End every source that has not ended yet. */
  endAll(): void
}

/** Options controlling the fake platform capabilities. */
export interface PlaybackAudioOptions {
  /** `unsupported` omits `setSinkId` from the context entirely. */
  sink?: 'ok' | 'fail' | 'unsupported'
  /** `false` makes the `AudioContext` constructor throw. */
  constructs?: boolean
  /** Start the context suspended so the resume path runs. */
  suspended?: boolean
  /** Make `resume()` reject, as an autoplay policy can. */
  resumeFails?: boolean
}

/**
 * Install a fake `AudioContext` for one test.
 * @param options - sink, construction, and initial suspension behavior.
 * @returns the fixture exposing contexts, sources, and scheduling observations.
 */
export function installPlaybackAudio(options: PlaybackAudioOptions = {}): PlaybackAudioFixture {
  const contexts: FakeContext[] = []
  function FakeAudioContext(): FakeContext {
    if (options.constructs === false) throw new Error('audio context unavailable')
    const sources: FakeSource[] = []
    const gain: FakeGain = { connect: vi.fn(), disconnect: vi.fn() }
    const analyser: FakeAnalyser = {
      fftSize: 128,
      signal: 0,
      buffers: [],
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData(target) {
        analyser.buffers.push(target)
        target.fill(analyser.signal)
      },
    }
    const decodeInputs: ArrayBuffer[] = []
    const context: FakeContext = {
      currentTime: 0,
      state: options.suspended === true ? 'suspended' : 'running',
      destination: {},
      decodeInputs,
      decodeAudioData: vi.fn(async (data: ArrayBuffer) => {
        decodeInputs.push(data)
        if (data.byteLength === 0) throw new Error('malformed wav')
        return { duration: data.byteLength / 1000 }
      }),
      resume: vi.fn(async () => {
        if (options.resumeFails === true) throw new Error('resume refused')
      }),
      sources,
      analyser,
      gain,
      createGain: () => gain,
      createAnalyser: () => analyser,
      createBufferSource() {
        const source: FakeSource = {
          buffer: null,
          onended: null,
          startedAt: null,
          ended: false,
          start(when) { source.startedAt = when },
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
        }
        sources.push(source)
        return source
      },
    }
    if (options.sink !== 'unsupported') {
      context.setSinkId = options.sink === 'fail'
        ? vi.fn(async () => { throw new Error('sink refused') })
        : vi.fn(async () => {})
    }
    contexts.push(context)
    return context
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)

  const context = (): FakeContext => {
    const latest = contexts.at(-1)
    if (!latest) throw new Error('no audio context was created')
    return latest
  }
  const sources = (): FakeSource[] => context().sources
  const end = (source: FakeSource | undefined): void => {
    if (!source || source.ended) throw new Error('source is not active')
    source.ended = true
    source.onended?.()
  }

  return {
    contexts,
    context,
    sources,
    createBufferSourceCount: () => sources().length,
    startTimes: () => sources().map(source => source.startedAt ?? Number.NaN),
    end(index) {
      end(sources()[index])
    },
    endLast() {
      end(sources().findLast(source => !source.ended && source.onended !== null))
    },
    endAll() {
      for (const source of sources()) if (!source.ended && source.onended !== null) end(source)
    },
  }
}

/**
 * Build a WAV-shaped buffer whose decoded duration is the requested seconds.
 * The fake decoder reads duration from the byte length; a zero-length buffer is malformed.
 * @param seconds - decoded duration the fake reports.
 * @returns buffer with one byte per millisecond.
 */
export function wav(seconds: number): ArrayBuffer {
  return new ArrayBuffer(Math.round(seconds * 1000))
}

/**
 * Drain pending decode and scheduling microtasks.
 * @returns after the queue settled in the current macrotask.
 */
export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
