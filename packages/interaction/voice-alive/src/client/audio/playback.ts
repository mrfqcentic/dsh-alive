/**
 * Ordered WAV playback over Web Audio.
 *
 * Chunks are decoded with `AudioContext.decodeAudioData` and scheduled back to
 * back on one gain bus, so the queue plays in arrival order without gaps or
 * overlap. `stop()` tears every source down synchronously, which is what keeps
 * barge-in silence inside the 150 ms bound; nothing waits on a timer.
 *
 * A chunk that fails to decode is dropped from the queue without cancelling
 * the chunks around it. Its `idle` run then rejects once with an
 * `Error.name === 'PlaybackChunkError'` whose `cause` is the decoder failure.
 * `stop()` rejects the active run once with `Error.name === 'AbortError'`;
 * chunks enqueued afterwards start a fresh run and a fresh `idle` promise.
 * @module @deepseek-ai/dsh-voice-alive/client/audio/playback
 */

/** One WAV chunk to speak, in queue order. */
export interface PlaybackChunk {
  /** Stable identifier used in decode-failure reports. */
  readonly id: string
  /** Complete WAV file bytes; the decoder owns only a copy. */
  readonly wav: ArrayBuffer
  /** Text spoken by this chunk, when the caller knows it. */
  readonly text?: string
}

/** Snapshot of the queue and the selected output. */
export interface PlaybackState {
  /** Whether at least one scheduled chunk is still sounding. */
  readonly playing: boolean
  /** Chunks accepted but not yet finished, including the sounding one. */
  readonly queued: number
  /** Last sampled output level, clamped to 0..1 and refreshed while playing. */
  readonly level: number
  /** Output device actually selected, or null while the system default is in use. */
  readonly deviceId: string | null
}

/** Ordered player for synthesized speech. */
export interface PlaybackController {
  /**
   * Append one WAV chunk to the ordered queue.
   * @param chunk - WAV bytes and the id used in decode-failure reports.
   */
  enqueue(chunk: PlaybackChunk): void
  /**
   * Resolves when the queue drains, rejects on stop or on a chunk decode failure.
   * It keeps the most recent run's promise after that run settles; a later enqueue replaces it.
   */
  readonly idle: Promise<void>
  /** Cut the queue and silence every scheduled source synchronously. */
  stop(): void
  /**
   * Route output to one device.
   * @param deviceId - output device id, as listed by {@link listOutputDevices}.
   * @returns after the sink accepted the device; rejects when routing is unavailable or refused.
   */
  setOutputDevice(deviceId: string): Promise<void>
  /** @returns the instantaneous output RMS, clamped to 0..1. */
  getLevel(): number
  /** Current queue and output snapshot. */
  readonly state: PlaybackState
  /**
   * Observe queue, level, and device changes.
   * @param listener - receives each published snapshot; level is sampled, not per frame.
   * @returns function that stops observing.
   */
  onChange(listener: (state: PlaybackState) => void): () => void
  /** @returns the single playback bus carrying the raw WAV mix, or null before audio starts. */
  createEchoReference(): AudioNode | null
}

/** Chromium's output-device routing extension on `AudioContext`. */
interface SinkCapableAudioContext extends AudioContext {
  setSinkId?(sinkId: string): Promise<void>
}

/** The part of `navigator.mediaDevices` playback relies on; browsers may omit enumeration before permission. */
interface DeviceEnumerator {
  enumerateDevices?(): Promise<MediaDeviceInfo[]>
}

/**
 * Read the platform device enumerator through a union return so a partial browser surface stays explicit.
 * @returns the enumerator, or undefined when the platform exposes no media devices.
 */
function outputEnumerator(): DeviceEnumerator | undefined {
  return globalThis.navigator.mediaDevices
}

/** The nodes one decoded chunk needs to play. */
interface Decoded {
  readonly buffer: AudioBuffer
  readonly context: AudioContext
  readonly output: AudioNode
}

/** One accepted chunk and its decode progress. */
interface Entry {
  readonly chunk: PlaybackChunk
  readonly index: number
  decoded: Decoded | null
  cancelled: boolean
}

/** Everything opened alongside the audio context. */
interface Wiring {
  readonly context: SinkCapableAudioContext
  readonly output: GainNode
  readonly analyser: AnalyserNode
  readonly samples: Float32Array<ArrayBuffer>
}

/** One playback run: the span one `idle` promise covers. A run exists only while unsettled. */
interface Run {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

/** Analyser window used for the output level; short enough to follow speech. */
const LEVEL_FFT_SIZE = 256

/** Level sampling interval; 20 notifications per second, not one per animation frame. */
const LEVEL_SAMPLE_MS = 50

/** Promise returned by `idle` while no run is active. */
const IDLE: Promise<void> = Promise.resolve()

/**
 * Build a named error without exporting an error hierarchy callers must import.
 * @param name - value assigned to `error.name`, the discriminator callers read.
 * @param message - human-readable failure.
 * @param cause - underlying failure, preserved for diagnostics.
 * @returns the named error.
 */
function playbackError(name: string, message: string, cause: unknown): Error {
  const error = new Error(message, { cause })
  error.name = name
  return error
}

/**
 * Create one ordered playback controller.
 * @param options - initial output device; it is applied when the audio context opens, and a refusal leaves
 * `state.deviceId` null (system default).
 * @returns the controller. Audio context creation is lazy, so `createPlayback` never opens hardware on its own.
 */
export function createPlayback(options: { deviceId?: string } = {}): PlaybackController {
  let wiring: Wiring | null = null
  let contextError: unknown
  let requestedDevice = options.deviceId ?? null
  let entries: Entry[] = []
  const active = new Map<AudioBufferSourceNode, Entry>()
  let nextStartTime = 0
  let nextIndex = 0
  let run: Run | null = null
  let lastIdle: Promise<void> = IDLE
  let failure: { index: number; error: Error } | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  let level = 0
  let current: PlaybackState = { playing: false, queued: 0, level: 0, deviceId: null }
  const listeners = new Set<(state: PlaybackState) => void>()

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener(current)
      } catch (error) {
        // Subscriber failure is not playback state; keep the queue running without console output.
        void error
      }
    }
  }

  function refresh(): void {
    const next: PlaybackState = {
      playing: active.size > 0,
      queued: entries.length + active.size,
      level,
      deviceId: current.deviceId,
    }
    if (next.playing === current.playing && next.queued === current.queued
      && next.level === current.level && next.deviceId === current.deviceId) return
    current = next
    notify()
  }

  function setDeviceId(deviceId: string | null): void {
    if (current.deviceId === deviceId) return
    current = { playing: current.playing, queued: current.queued, level: current.level, deviceId }
    notify()
  }

  function ensureContext(): Wiring | null {
    if (wiring) return wiring
    if (typeof globalThis.AudioContext === 'undefined') return null
    let created: AudioContext
    try {
      created = new globalThis.AudioContext()
    } catch (error) {
      // The platform refused a context; remember why so the first chunk reports it.
      contextError = error
      return null
    }
    const sink: SinkCapableAudioContext = created
    const output = created.createGain()
    const analyser = created.createAnalyser()
    analyser.fftSize = LEVEL_FFT_SIZE
    output.connect(analyser)
    analyser.connect(created.destination)
    wiring = { context: sink, output, analyser, samples: new Float32Array(analyser.fftSize) }
    if (created.state === 'suspended') {
      // Autoplay policy may refuse resume until the next gesture; scheduled sources stay queued either way.
      void created.resume().catch(() => undefined)
    }
    const target = requestedDevice
    if (target !== null && typeof sink.setSinkId === 'function') {
      // The constructor cannot await; a failed initial route leaves state.deviceId null (system default).
      void sink.setSinkId(target).then(
        () => {
          requestedDevice = target
          setDeviceId(target)
        },
        () => undefined,
      )
    }
    return wiring
  }

  function stopTicker(): void {
    if (ticker === null) return
    clearInterval(ticker)
    ticker = null
  }

  function readLevel(): number {
    if (!wiring) return 0
    const { analyser, samples } = wiring
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) sum += sample * sample
    if (!Number.isFinite(sum)) return 0
    const rms = Math.sqrt(sum / samples.length)
    return Math.min(1, Math.max(0, rms))
  }

  function sampleLevel(): void {
    level = readLevel()
    refresh()
  }

  function startTicker(): void {
    if (ticker !== null) return
    ticker = setInterval(sampleLevel, LEVEL_SAMPLE_MS)
  }

  function maybeSettle(): void {
    if (entries.length > 0 || active.size > 0) return
    const settled = run
    const error = failure
    run = null
    failure = null
    stopTicker()
    level = 0
    nextStartTime = 0
    if (!settled) return
    if (error) settled.reject(error.error)
    else settled.resolve()
    refresh()
  }

  function finish(source: AudioBufferSourceNode): void {
    active.delete(source)
    source.disconnect()
    if (active.size === 0) {
      stopTicker()
      level = 0
      nextStartTime = 0
    }
    refresh()
    maybeSettle()
  }

  function schedule(entry: Entry, decoded: Decoded): void {
    const source = decoded.context.createBufferSource()
    source.buffer = decoded.buffer
    source.connect(decoded.output)
    const startAt = Math.max(decoded.context.currentTime, nextStartTime)
    nextStartTime = startAt + decoded.buffer.duration
    active.set(source, entry)
    source.onended = () => { finish(source) }
    source.start(startAt)
    startTicker()
    refresh()
  }

  function pump(): void {
    let head = entries.shift()
    while (head) {
      const decoded = head.decoded
      if (decoded === null) {
        entries.unshift(head)
        return
      }
      schedule(head, decoded)
      head = entries.shift()
    }
    maybeSettle()
  }

  function fail(entry: Entry, error: Error): void {
    if (entry.cancelled) return
    entry.cancelled = true
    entries = entries.filter(candidate => candidate !== entry)
    if (failure === null || entry.index < failure.index) failure = { index: entry.index, error }
    pump()
  }

  function chunkFailure(chunk: PlaybackChunk, cause: unknown): Error {
    return playbackError('PlaybackChunkError', `Playback chunk ${JSON.stringify(chunk.id)} failed to decode`, cause)
  }

  function enqueue(chunk: PlaybackChunk): void {
    if (run === null) {
      const pending = Promise.withResolvers<void>()
      const created: Run = { promise: pending.promise, resolve: pending.resolve, reject: pending.reject }
      // Callers that never observe `idle` must not turn a stop or decode failure into an unhandled rejection.
      void created.promise.catch(() => undefined)
      run = created
      lastIdle = created.promise
      failure = null
      nextIndex = 0
    }
    const entry: Entry = { chunk, index: nextIndex++, decoded: null, cancelled: false }
    entries.push(entry)
    refresh()
    const opened = ensureContext()
    const unavailable = playbackError('PlaybackUnavailableError', 'Web Audio is unavailable in this environment', contextError)
    if (!opened) {
      fail(entry, unavailable)
      return
    }
    let decoded: Promise<AudioBuffer>
    try {
      decoded = opened.context.decodeAudioData(chunk.wav.slice(0))
    } catch (error) {
      fail(entry, chunkFailure(chunk, error))
      return
    }
    void decoded.then(
      (buffer) => {
        if (entry.cancelled) return
        entry.decoded = { buffer, context: opened.context, output: opened.output }
        pump()
      },
      (error: unknown) => { fail(entry, chunkFailure(chunk, error)) },
    )
  }

  function stop(): void {
    const pending = run
    const entriesToCancel = entries
    entries = []
    for (const entry of entriesToCancel) entry.cancelled = true
    for (const [source, entry] of active) {
      entry.cancelled = true
      source.onended = null
      source.stop()
      source.disconnect()
    }
    active.clear()
    run = null
    failure = null
    stopTicker()
    level = 0
    nextStartTime = 0
    if (pending) pending.reject(playbackError('AbortError', 'Playback stopped', undefined))
    refresh()
  }

  async function setOutputDevice(deviceId: string): Promise<void> {
    const opened = ensureContext()
    if (!opened) {
      throw playbackError('PlaybackUnavailableError', 'Web Audio is unavailable in this environment', contextError)
    }
    const context = opened.context
    if (typeof context.setSinkId !== 'function') {
      throw playbackError('PlaybackDeviceError', 'This environment cannot route to a specific output device', undefined)
    }
    try {
      await context.setSinkId(deviceId)
    } catch (error) {
      throw playbackError('PlaybackDeviceError', `Output device ${JSON.stringify(deviceId)} could not be selected`, error)
    }
    requestedDevice = deviceId
    setDeviceId(deviceId)
  }

  return {
    enqueue,
    get idle() { return lastIdle },
    stop,
    setOutputDevice,
    getLevel: readLevel,
    get state() { return current },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    createEchoReference: () => wiring?.output ?? null,
  }
}

/**
 * List the browser's audio output devices.
 * @returns devices in browser order. The first entry is marked default when the browser reports no explicit
 * `default` device; an environment without device enumeration reports none.
 */
export async function listOutputDevices(): Promise<Array<{ id: string; label: string; isDefault: boolean }>> {
  const media = outputEnumerator()
  if (media?.enumerateDevices === undefined) return []
  const devices = await media.enumerateDevices()
  const outputs = devices.filter(device => device.kind === 'audiooutput')
  const explicitDefault = outputs.some(device => device.deviceId === 'default')
  return outputs.map((device, index) => ({
    id: device.deviceId,
    label: device.label,
    isDefault: explicitDefault ? device.deviceId === 'default' : index === 0,
  }))
}
