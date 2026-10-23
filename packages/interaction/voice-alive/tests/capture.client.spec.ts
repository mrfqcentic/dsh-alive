/** Capture controller: fake Web Audio graph, framing, resampling, mute, devices, errors, and cleanup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureError, createCapture } from '../src/client/audio/capture.ts'
import type { CaptureController, SpeechSegment, WordGate } from '../src/client/audio/types.ts'
import { SAMPLE_RATE } from '../src/client/audio/vad.ts'

/** One fake media stream track that records its ended listeners and stop calls. */
class FakeTrack {
  stopped = false
  readonly label = 'Fake microphone'
  private readonly handlers = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void, options?: { signal?: AbortSignal }): void {
    const handlers = this.handlers.get(type) ?? new Set<() => void>()
    handlers.add(listener)
    this.handlers.set(type, handlers)
    options?.signal?.addEventListener('abort', () => { handlers.delete(listener) })
  }

  stop(): void {
    this.stopped = true
  }

  end(): void {
    for (const listener of [...(this.handlers.get('ended') ?? [])]) listener()
  }
}

/** Fake stream exposing its tracks to capture and to tests. */
class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}

  getTracks(): FakeTrack[] {
    return this.tracks
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks
  }
}

/** Fake audio node recording graph connections. */
class FakeNode {
  readonly connected: unknown[] = []
  disconnect = vi.fn()

  connect(target: unknown): void {
    this.connected.push(target)
  }
}

/** Fake gain node whose value the capture graph silences. */
class FakeGain extends FakeNode {
  readonly gain = { value: 1 }
}

/** Fake AudioWorkletNode with the message port capture drives. */
class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = []
  readonly port: {
    onmessage: ((event: { data: Float32Array }) => void) | null
    close: ReturnType<typeof vi.fn>
  }

  constructor(readonly context: unknown, readonly name: string) {
    super()
    this.port = { onmessage: null, close: vi.fn() }
    FakeWorkletNode.instances.push(this)
  }
}

/** Fake audio context with switchable failure modes for the error-path tests. */
class FakeContext {
  static instances: FakeContext[] = []
  static constructed = 0
  static throwNext = 0
  static throwAlways = false
  static withoutWorklet = false
  static startSuspended = false
  static resumeFails = false
  static reportedRate: number | undefined
  static addModule: (url: string) => Promise<void> = async () => {}

  readonly destination = new FakeNode()
  readonly source = new FakeNode()
  readonly gain = new FakeGain()
  readonly sampleRate: number
  readonly audioWorklet: { addModule: ReturnType<typeof vi.fn> } | undefined
  state: string
  readonly resume = vi.fn(async () => {
    if (FakeContext.resumeFails) throw new Error('autoplay policy refused resume')
    this.state = 'running'
  })
  readonly close = vi.fn(async () => { this.state = 'closed' })

  constructor(options?: { sampleRate?: number }) {
    FakeContext.constructed += 1
    if (FakeContext.throwAlways || FakeContext.constructed <= FakeContext.throwNext) throw new Error('rate unsupported')
    this.sampleRate = FakeContext.reportedRate ?? options?.sampleRate ?? 48000
    this.state = FakeContext.startSuspended ? 'suspended' : 'running'
    this.audioWorklet = FakeContext.withoutWorklet
      ? undefined
      : { addModule: vi.fn((url: string) => FakeContext.addModule(url)) }
    FakeContext.instances.push(this)
  }

  createMediaStreamSource(_stream: unknown): FakeNode {
    return this.source
  }

  createGain(): FakeGain {
    return this.gain
  }
}

/** Environment one capture starts against. */
interface Environment {
  readonly getUserMedia: ReturnType<typeof vi.fn>
  readonly stream: FakeStream
  readonly track: FakeTrack
}

/** Running capture plus the fakes it is attached to. */
interface Session {
  readonly controller: CaptureController
  readonly segments: SpeechSegment[]
  readonly errors: CaptureError[]
  readonly env: Environment
  readonly context: FakeContext
  readonly node: FakeWorkletNode
  push(samples: ArrayLike<number>): void
}

/**
 * Reset every fake's static state and install the browser globals.
 * @returns nothing.
 */
function resetFakes(): void {
  FakeContext.instances = []
  FakeContext.constructed = 0
  FakeContext.throwNext = 0
  FakeContext.throwAlways = false
  FakeContext.withoutWorklet = false
  FakeContext.startSuspended = false
  FakeContext.resumeFails = false
  FakeContext.reportedRate = undefined
  FakeContext.addModule = async () => {}
  FakeWorkletNode.instances = []
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
}

/**
 * Install a fake `navigator.mediaDevices`.
 * @param override - replacement `getUserMedia`; resolves one fake stream otherwise.
 * @returns the recorded calls plus the stream and track they resolve to.
 */
function installEnvironment(
  override?: (constraints: MediaStreamConstraints) => Promise<FakeStream>,
): Environment {
  const track = new FakeTrack()
  const stream = new FakeStream([track])
  const getUserMedia = vi.fn(override ?? (async () => stream))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return { getUserMedia, stream, track }
}

/**
 * Let pending microtasks run.
 * @param turns - number of microtask turns.
 * @returns after the turns complete.
 */
async function tick(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

/**
 * Push normalized samples through the worklet in render-sized blocks.
 * @param session - running capture.
 * @param samples - normalized samples to send.
 * @param block - render block size.
 */
function pushPcm(session: Session, samples: Float32Array, block = 128): void {
  for (let offset = 0; offset < samples.length; offset += block) {
    session.push(samples.subarray(offset, offset + block))
  }
}

/**
 * Deterministic silence.
 * @param rate - sample rate.
 * @param seconds - duration.
 * @returns normalized silent samples.
 */
function silenceSamples(rate: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(rate * seconds))
}

/**
 * Deterministic sine tone.
 * @param rate - sample rate.
 * @param seconds - duration.
 * @param frequency - frequency in hertz.
 * @param amplitude - peak amplitude.
 * @returns normalized tone samples.
 */
function toneSamples(rate: number, seconds: number, frequency: number, amplitude: number): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate)
  }
  return samples
}

/**
 * Deterministic square wave used to prove sample clamping.
 * @param rate - sample rate.
 * @param seconds - duration.
 * @param frequency - frequency in hertz.
 * @returns samples that exceed the normalized range by a factor of two.
 */
function squareSamples(rate: number, seconds: number, frequency: number): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds))
  const period = rate / frequency
  for (let i = 0; i < samples.length; i += 1) samples[i] = i % period < period / 2 ? 2 : -2
  return samples
}

/**
 * Measure a segment's dominant frequency from the loud part of its PCM.
 * @param segment - segmented PCM.
 * @returns frequency in hertz for a single-tone signal.
 */
function measuredFrequency(segment: SpeechSegment): number {
  const threshold = segment.peak * 0.3
  let first = -1
  let last = -1
  for (const [index, sample] of segment.pcm.entries()) {
    if (Math.abs(sample / 32768) >= threshold) {
      if (first < 0) first = index
      last = index
    }
  }
  if (first < 0 || last <= first) return 0
  let crossings = 0
  let previous = segment.pcm[first]!
  for (let index = first + 1; index <= last; index += 1) {
    const sample = segment.pcm[index]!
    if ((sample >= 0) !== (previous >= 0)) crossings += 1
    previous = sample
  }
  return ((crossings / (last - first)) * SAMPLE_RATE) / 2
}

/** Options for {@link openSession}. */
interface OpenOptions {
  deviceId?: string
  gate?: WordGate
  reportedRate?: number
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<FakeStream>
}

/**
 * Start one capture against the fake graph.
 * @param options - device, gate, and fake behavior.
 * @returns the running session.
 */
async function openSession(options: OpenOptions = {}): Promise<Session> {
  if (options.reportedRate !== undefined) FakeContext.reportedRate = options.reportedRate
  const env = installEnvironment(options.getUserMedia)
  const captureOptions: { deviceId?: string; gate?: WordGate } = {}
  if (options.deviceId !== undefined) captureOptions.deviceId = options.deviceId
  if (options.gate !== undefined) captureOptions.gate = options.gate
  const controller = createCapture(captureOptions)
  const segments: SpeechSegment[] = []
  const errors: CaptureError[] = []
  controller.onSegment((segment) => { segments.push(segment) })
  controller.onError((error) => { errors.push(error) })
  await controller.start()
  const context = FakeContext.instances.at(-1)
  const node = FakeWorkletNode.instances.at(-1)
  if (context === undefined || node === undefined) throw new Error('capture did not attach')
  return {
    controller,
    segments,
    errors,
    env,
    context,
    node,
    push(samples) {
      const current = FakeWorkletNode.instances.at(-1)
      const handler = current?.port.onmessage
      if (handler === null || handler === undefined) throw new Error('the worklet port is closed')
      handler({ data: Float32Array.from(samples) })
    },
  }
}

/**
 * Push one spoken utterance followed by enough silence to close it.
 * @param session - running capture.
 * @param rate - capture sample rate.
 * @param seconds - utterance duration.
 * @param frequency - tone frequency.
 * @returns nothing.
 */
function utter(session: Session, rate: number, seconds = 0.6, frequency = 440): void {
  pushPcm(session, toneSamples(rate, seconds, frequency, 0.3))
  pushPcm(session, silenceSamples(rate, 1.4))
}

beforeEach(() => {
  resetFakes()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('acquisition', () => {
  it('captures 16 kHz mono through a worklet and emits one accepted segment', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const session = await openSession()
    expect(session.controller.state).toBe('running')

    const constraints = session.env.getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints | undefined
    expect(constraints?.video).toBe(false)
    expect(constraints?.audio).toMatchObject({
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
    expect((constraints?.audio as MediaTrackConstraints).deviceId).toBeUndefined()
    expect(session.context.sampleRate).toBe(16000)

    const worklet = session.context.audioWorklet?.addModule
    expect(worklet).toHaveBeenCalledTimes(1)
    expect(String(worklet?.mock.calls[0]?.[0])).toMatch(/^blob:/)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(session.node.name).toBe('dsh-voice-capture')
    expect(session.node.connected).toContain(session.context.gain)
    expect(session.context.source.connected).toContain(session.node)
    expect(session.context.gain.gain.value).toBe(0)
    expect(session.context.gain.connected).toContain(session.context.destination)

    utter(session, 16000)
    await tick()
    expect(session.segments).toHaveLength(1)
    const segment = session.segments[0]!
    expect(segment.id).toBe(0)
    expect(segment.rms).toBeGreaterThan(0.01)
    expect(measuredFrequency(segment)).toBeGreaterThan(400)
    expect(measuredFrequency(segment)).toBeLessThan(480)

    session.controller.stop()
    expect(session.controller.state).toBe('idle')
    await tick()
    expect(session.env.track.stopped).toBe(true)
    expect(session.context.state).toBe('closed')
  })

  it('selects the requested device and follows a switch to another one', async () => {
    const first = await openSession({ deviceId: 'mic-a' })
    const firstAudio = first.env.getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints | undefined
    expect((firstAudio?.audio as MediaTrackConstraints).deviceId).toEqual({ exact: 'mic-a' })
    first.controller.stop()
    await tick()

    const second = await openSession({ deviceId: 'mic-b' })
    const secondAudio = second.env.getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints | undefined
    expect((secondAudio?.audio as MediaTrackConstraints).deviceId).toEqual({ exact: 'mic-b' })
    expect(second.env.getUserMedia).toHaveBeenCalledTimes(1)
    second.controller.stop()
  })

  it('resumes a suspended audio context before reporting running', async () => {
    FakeContext.startSuspended = true
    const session = await openSession()
    expect(session.controller.state).toBe('running')
    expect(session.context.resume).toHaveBeenCalledTimes(1)
    expect(session.context.state).toBe('running')
    session.controller.stop()
  })

  it('is idempotent while running and ignores a concurrent start', async () => {
    const session = await openSession()
    await session.controller.start()
    expect(session.env.getUserMedia).toHaveBeenCalledTimes(1)
    session.controller.stop()

    const deferred = Promise.withResolvers<FakeStream>()
    resetFakes()
    const env = installEnvironment(() => deferred.promise)
    const controller = createCapture()
    const first = controller.start()
    const second = controller.start()
    deferred.resolve(env.stream)
    await Promise.all([first, second])
    expect(env.getUserMedia).toHaveBeenCalledTimes(1)
    expect(controller.state).toBe('running')
    controller.stop()
  })
})

describe('word gate', () => {
  it('delivers two utterances as two segments separated by silence', async () => {
    const session = await openSession({ gate: { accept: () => true } })
    utter(session, 16000, 0.5)
    await tick()
    utter(session, 16000, 0.5)
    await tick()
    expect(session.segments.map(segment => segment.id)).toEqual([0, 1])
    expect(session.segments[1]!.startedAt).toBeGreaterThan(session.segments[0]!.endedAt)
    session.controller.stop()
  })

  it('drops a segment the gate refuses and stays running', async () => {
    const session = await openSession({ gate: { accept: () => false } })
    utter(session, 16000)
    await tick()
    expect(session.segments).toEqual([])
    expect(session.controller.state).toBe('running')
    session.controller.stop()
  })

  it('waits for an asynchronous gate before delivering', async () => {
    const deferred = Promise.withResolvers<boolean>()
    const session = await openSession({ gate: { accept: () => deferred.promise } })
    utter(session, 16000)
    await tick()
    expect(session.segments).toEqual([])
    deferred.resolve(true)
    await tick()
    expect(session.segments).toHaveLength(1)
    session.controller.stop()
  })

  it('uses the conservative energy gate when none is injected', async () => {
    const session = await openSession()
    // 30 frames of a quiet tone clear the VAD threshold but not the word gate.
    pushPcm(session, toneSamples(16000, 0.6, 440, 0.012))
    pushPcm(session, silenceSamples(16000, 1.4))
    await tick()
    expect(session.segments).toEqual([])
    expect(session.controller.state).toBe('running')

    utter(session, 16000)
    await tick()
    expect(session.segments).toHaveLength(1)
    session.controller.stop()
  })

  it('reports a throwing gate as an unsupported failure and releases capture', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const session = await openSession({
      gate: {
        accept: () => {
          throw new Error('gate crashed')
        },
      },
    })
    utter(session, 16000)
    await tick()
    expect(session.segments).toEqual([])
    expect(session.errors).toHaveLength(1)
    expect(session.errors[0]?.kind).toBe('unsupported')
    expect(session.errors[0]?.cause).toBeInstanceOf(Error)
    expect(session.controller.state).toBe('error')
    await tick()
    expect(session.env.track.stopped).toBe(true)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('reports a rejected gate and releases capture', async () => {
    const session = await openSession({ gate: { accept: () => Promise.reject(new Error('no transcript')) } })
    utter(session, 16000)
    await tick()
    expect(session.errors[0]?.kind).toBe('unsupported')
    expect(session.controller.state).toBe('error')
  })
})

describe('mute', () => {
  it('releases the microphone and discards segments until unmuted', async () => {
    const session = await openSession({ gate: { accept: () => true } })
    const staleHandler = session.node.port.onmessage
    session.controller.setMuted(true)
    expect(session.controller.state).toBe('muted')
    expect(session.env.track.stopped).toBe(true)
    expect(session.context.state).toBe('closed')
    expect(session.node.port.onmessage).toBeNull()
    expect(session.node.disconnect).toHaveBeenCalled()

    staleHandler?.({ data: toneSamples(16000, 0.6, 440, 0.3) })
    await tick()
    expect(session.segments).toEqual([])

    session.controller.setMuted(true)
    expect(session.context.close).toHaveBeenCalledTimes(1)

    session.controller.setMuted(false)
    await tick(12)
    expect(session.controller.state).toBe('running')
    expect(session.env.getUserMedia).toHaveBeenCalledTimes(2)
    utter(session, 16000)
    await tick()
    expect(session.segments).toHaveLength(1)
    session.controller.stop()
  })

  it('keeps segment ids unique across mute and unmute', async () => {
    const session = await openSession({ gate: { accept: () => true } })
    utter(session, 16000, 0.5)
    await tick()
    expect(session.segments.map(segment => segment.id)).toEqual([0])

    session.controller.setMuted(true)
    session.controller.setMuted(false)
    await tick(12)
    expect(session.controller.state).toBe('running')

    utter(session, 16000, 0.5)
    await tick()
    expect(session.segments.map(segment => segment.id)).toEqual([0, 1])
    session.controller.stop()
  })

  it('does not start capture when unmuting a controller that was idle', async () => {
    installEnvironment()
    const controller = createCapture()
    expect(controller.state).toBe('idle')
    controller.setMuted(true)
    expect(controller.state).toBe('muted')
    controller.setMuted(false)
    expect(controller.state).toBe('idle')
    await tick()
    expect(FakeContext.instances).toEqual([])
  })

  it('ignores an unmute request while running', async () => {
    const session = await openSession()
    session.controller.setMuted(false)
    expect(session.controller.state).toBe('running')
    expect(session.env.getUserMedia).toHaveBeenCalledTimes(1)
    session.controller.stop()
  })

  it('drops a segment whose gate was still running when mute arrived', async () => {
    const deferred = Promise.withResolvers<boolean>()
    const session = await openSession({ gate: { accept: () => deferred.promise } })
    utter(session, 16000)
    await tick()
    session.controller.setMuted(true)
    deferred.resolve(true)
    await tick()
    expect(session.segments).toEqual([])
  })

  it('keeps the muted state when a pending gate fails after mute', async () => {
    const deferred = Promise.withResolvers<boolean>()
    const session = await openSession({ gate: { accept: () => deferred.promise } })
    utter(session, 16000)
    await tick()
    session.controller.setMuted(true)
    deferred.reject(new Error('recognition stopped'))
    await tick()
    expect(session.errors).toEqual([])
    expect(session.controller.state).toBe('muted')
  })

  it('drops a closed segment delivered after mute in the same turn', async () => {
    const session = await openSession({ gate: { accept: () => true } })
    utter(session, 16000)
    session.controller.setMuted(true)
    await tick()
    expect(session.segments).toEqual([])
  })
})

describe('listeners', () => {
  it('unsubscribes segment and error listeners', async () => {
    const session = await openSession()
    const segment = vi.fn()
    const error = vi.fn()
    const stopSegment = session.controller.onSegment(segment)
    const stopError = session.controller.onError(error)
    stopSegment()
    stopError()
    utter(session, 16000)
    await tick()
    expect(session.segments).toHaveLength(1)
    expect(segment).not.toHaveBeenCalled()

    session.controller.stop()
    await tick()
    expect(error).not.toHaveBeenCalled()
  })

  it('contains a throwing segment listener and still notifies the rest', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const session = await openSession({ gate: { accept: () => true } })
    const late = vi.fn()
    session.controller.onSegment(() => {
      throw new Error('listener failed')
    })
    session.controller.onSegment(late)
    utter(session, 16000)
    await tick()
    expect(late).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith('voice capture segment listener failed', expect.any(Error))
    expect(session.controller.state).toBe('running')
    session.controller.stop()
  })

  it('contains a throwing error listener and still notifies the rest', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('navigator', {})
    const controller = createCapture()
    const late = vi.fn()
    controller.onError(() => {
      throw new Error('error listener failed')
    })
    controller.onError(late)
    await controller.start()
    expect(late).toHaveBeenCalledTimes(1)
    expect(late.mock.calls[0]?.[0]).toBeInstanceOf(CaptureError)
    expect(consoleError).toHaveBeenCalledWith('voice capture error listener failed', expect.any(Error))
    expect(controller.state).toBe('error')
  })
})

describe('failures', () => {
  it('reports denied permission without creating an audio context', async () => {
    const env = installEnvironment(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    const controller = createCapture()
    await controller.start()
    expect(controller.state).toBe('error')
    expect(env.getUserMedia).toHaveBeenCalledTimes(1)
    expect(FakeContext.instances).toEqual([])
  })

  it('reports a missing media device registry as unsupported', async () => {
    vi.stubGlobal('navigator', {})
    const controller = createCapture()
    await controller.start()
    expect(controller.state).toBe('error')
    expect(FakeContext.instances).toEqual([])
  })

  it('maps an unclassified platform failure to unsupported', async () => {
    const cause = new Error('constraint explosion')
    installEnvironment(() => Promise.reject(cause))
    const controller = createCapture()
    const errors: CaptureError[] = []
    controller.onError((error) => { errors.push(error) })
    await controller.start()
    expect(errors[0]?.kind).toBe('unsupported')
    expect(errors[0]?.cause).toBe(cause)
  })

  it('reports a missing AudioContext and stops the acquired stream', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const env = installEnvironment()
    const controller = createCapture()
    await controller.start()
    expect(controller.state).toBe('error')
    expect(env.track.stopped).toBe(true)
  })

  it('reports a missing AudioWorklet and stops the acquired stream', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined)
    const env = installEnvironment()
    const controller = createCapture()
    const errors: CaptureError[] = []
    controller.onError((error) => { errors.push(error) })
    await controller.start()
    expect(errors[0]?.kind).toBe('unsupported')
    expect(env.track.stopped).toBe(true)
    expect(FakeContext.instances[0]?.state).toBe('closed')
  })

  it('reports a context without an audioWorklet', async () => {
    FakeContext.withoutWorklet = true
    const env = installEnvironment()
    const controller = createCapture()
    await controller.start()
    expect(controller.state).toBe('error')
    expect(env.track.stopped).toBe(true)
    expect(FakeContext.instances[0]?.state).toBe('closed')
  })

  it('reports a worklet module that fails to load and revokes its blob URL', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    FakeContext.addModule = async () => { throw new Error('csp blocked blob') }
    const env = installEnvironment()
    const controller = createCapture()
    const errors: CaptureError[] = []
    controller.onError((error) => { errors.push(error) })
    await controller.start()
    expect(errors[0]?.kind).toBe('unsupported')
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(env.track.stopped).toBe(true)
    expect(FakeContext.instances[0]?.state).toBe('closed')
  })

  it('reports a context whose construction always fails and stops the stream', async () => {
    FakeContext.throwAlways = true
    const env = installEnvironment()
    const controller = createCapture()
    const errors: CaptureError[] = []
    controller.onError((error) => { errors.push(error) })
    await controller.start()
    expect(errors[0]?.kind).toBe('unsupported')
    expect(env.track.stopped).toBe(true)
  })

  it('falls back to the default context rate and resamples instead of dropping samples', async () => {
    FakeContext.throwNext = 1
    const env = installEnvironment()
    const controller = createCapture()
    const segments: SpeechSegment[] = []
    controller.onSegment((segment) => { segments.push(segment) })
    await controller.start()
    const context = FakeContext.instances[0]!
    expect(context.sampleRate).toBe(48000)
    const node = FakeWorkletNode.instances[0]!
    const push = (samples: Float32Array): void => {
      for (let offset = 0; offset < samples.length; offset += 128) {
        node.port.onmessage?.({ data: samples.subarray(offset, offset + 128) })
      }
    }
    push(toneSamples(48000, 1, 1000, 0.3))
    push(silenceSamples(48000, 1.4))
    await tick()
    expect(segments).toHaveLength(1)
    expect(measuredFrequency(segments[0]!)).toBeGreaterThan(950)
    expect(measuredFrequency(segments[0]!)).toBeLessThan(1050)
    controller.stop()
    await tick()
    expect(env.track.stopped).toBe(true)
  })

  it('reports a refused context resume as unsupported and releases the graph', async () => {
    FakeContext.startSuspended = true
    FakeContext.resumeFails = true
    const env = installEnvironment()
    const controller = createCapture()
    const errors: CaptureError[] = []
    controller.onError((error) => { errors.push(error) })
    await controller.start()
    expect(errors[0]?.kind).toBe('unsupported')
    expect(errors[0]?.cause).toBeInstanceOf(Error)
    expect(controller.state).toBe('error')
    expect(env.track.stopped).toBe(true)
    expect(FakeContext.instances[0]?.state).toBe('closed')
    expect(FakeContext.instances[0]?.resume).toHaveBeenCalledTimes(1)
  })

  it('reports a track that ends by itself and releases the graph', async () => {
    const session = await openSession()
    session.env.track.end()
    expect(session.controller.state).toBe('error')
    expect(session.errors[0]?.kind).toBe('no-device')
    await tick()
    expect(session.env.track.stopped).toBe(true)
    expect(session.context.state).toBe('closed')
  })

  it('contains a failing audio context close', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const session = await openSession()
    session.context.close.mockRejectedValueOnce(new Error('close failed'))
    session.controller.stop()
    await tick()
    expect(consoleError).toHaveBeenCalledWith('voice capture release failed', expect.any(Error))
    expect(session.controller.state).toBe('idle')
  })
})

describe('cancellation', () => {
  it('discards a stream that arrives after stop and still cleans it up', async () => {
    const deferred = Promise.withResolvers<FakeStream>()
    const env = installEnvironment(() => deferred.promise)
    const controller = createCapture()
    const starting = controller.start()
    controller.stop()
    deferred.resolve(env.stream)
    await starting
    expect(controller.state).toBe('idle')
    expect(env.track.stopped).toBe(true)
    expect(FakeContext.instances[0]?.state).toBe('closed')
  })

  it('restarts acquisition when mute and unmute arrive during the permission prompt', async () => {
    const first = Promise.withResolvers<FakeStream>()
    const second = Promise.withResolvers<FakeStream>()
    const pending = [first, second]
    let calls = 0
    installEnvironment(() => {
      const next = pending[calls]
      calls += 1
      if (next === undefined) throw new Error('unexpected extra acquisition')
      return next.promise
    })
    const firstTrack = new FakeTrack()
    const secondTrack = new FakeTrack()
    const controller = createCapture()

    const started = controller.start()
    controller.setMuted(true)
    controller.setMuted(false)
    expect(controller.state).toBe('running')

    first.resolve(new FakeStream([firstTrack]))
    second.resolve(new FakeStream([secondTrack]))
    await started
    expect(controller.state).toBe('running')
    expect(calls).toBe(2)
    expect(firstTrack.stopped).toBe(true)
    expect(secondTrack.stopped).toBe(false)
    expect(FakeContext.instances).toHaveLength(2)
    expect(FakeContext.instances[0]?.state).toBe('closed')
    expect(FakeContext.instances[1]?.state).toBe('running')
    expect(FakeWorkletNode.instances[0]?.port.onmessage).toBeNull()
    expect(FakeWorkletNode.instances[1]?.port.onmessage).not.toBeNull()
    controller.stop()
  })

  it('restarts acquisition when start is called again during the permission prompt', async () => {
    const first = Promise.withResolvers<FakeStream>()
    const second = Promise.withResolvers<FakeStream>()
    const pending = [first, second]
    let calls = 0
    installEnvironment(() => {
      const next = pending[calls]
      calls += 1
      if (next === undefined) throw new Error('unexpected extra acquisition')
      return next.promise
    })
    const firstTrack = new FakeTrack()
    const secondTrack = new FakeTrack()
    const controller = createCapture()

    const firstStart = controller.start()
    controller.stop()
    const secondStart = controller.start()

    first.resolve(new FakeStream([firstTrack]))
    second.resolve(new FakeStream([secondTrack]))
    await Promise.all([firstStart, secondStart])
    expect(controller.state).toBe('running')
    expect(calls).toBe(2)
    expect(firstTrack.stopped).toBe(true)
    expect(secondTrack.stopped).toBe(false)
    expect(FakeContext.instances[0]?.state).toBe('closed')
    expect(FakeContext.instances[1]?.state).toBe('running')
    controller.stop()
  })

  it('ignores a rejection that arrives after stop', async () => {
    const deferred = Promise.withResolvers<FakeStream>()
    installEnvironment(() => deferred.promise)
    const controller = createCapture()
    const errors: CaptureError[] = []
    controller.onError((error) => { errors.push(error) })
    const starting = controller.start()
    controller.stop()
    deferred.reject(new DOMException('unplugged', 'NotFoundError'))
    await starting
    expect(errors).toEqual([])
    expect(controller.state).toBe('idle')
  })

  it('discards a worklet that finishes loading after stop', async () => {
    const deferred = Promise.withResolvers<undefined>()
    FakeContext.addModule = () => deferred.promise
    const env = installEnvironment()
    const controller = createCapture()
    const starting = controller.start()
    await tick()
    expect(FakeContext.instances).toHaveLength(1)
    controller.stop()
    deferred.resolve(undefined)
    await starting
    expect(controller.state).toBe('idle')
    expect(env.track.stopped).toBe(true)
    expect(FakeContext.instances[0]?.state).toBe('closed')
  })

  it('stops an idle controller without touching resources', () => {
    installEnvironment()
    const controller = createCapture()
    controller.stop()
    controller.stop()
    expect(controller.state).toBe('idle')
    expect(FakeContext.instances).toEqual([])
  })
})

describe('resampling', () => {
  it('upsamples an 8 kHz context to the 16 kHz capture rate', async () => {
    const session = await openSession({ reportedRate: 8000 })
    pushPcm(session, toneSamples(8000, 1, 440, 0.3))
    pushPcm(session, silenceSamples(8000, 1.4))
    await tick()
    expect(session.segments).toHaveLength(1)
    expect(measuredFrequency(session.segments[0]!)).toBeGreaterThan(410)
    expect(measuredFrequency(session.segments[0]!)).toBeLessThan(470)
    session.controller.stop()
  })

  it('filters content above the 16 kHz Nyquist instead of aliasing it into speech', async () => {
    const session = await openSession({ reportedRate: 48000 })
    // Naive decimation folds 13 kHz to 3 kHz, inside the speech band; the
    // anti-aliasing kernel must remove it before the detector sees a frame.
    pushPcm(session, toneSamples(48000, 2, 13000, 0.5))
    pushPcm(session, silenceSamples(48000, 1.4))
    await tick()
    expect(session.segments).toEqual([])
    session.controller.stop()
  })

  it('clamps samples that exceed full scale', async () => {
    const session = await openSession()
    pushPcm(session, squareSamples(16000, 1, 1000))
    pushPcm(session, silenceSamples(16000, 1.4))
    await tick()
    expect(session.segments).toHaveLength(1)
    expect(session.segments[0]!.peak).toBe(1)
    session.controller.stop()
  })
})
