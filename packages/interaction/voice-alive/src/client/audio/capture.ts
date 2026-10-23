/**
 * 16 kHz mono microphone capture, resampling, framing, and VAD segmentation.
 *
 * Capture uses `getUserMedia` plus an `AudioWorklet` loaded from a blob URL,
 * so the bundle needs no second asset. `AudioContext` is asked for 16 kHz
 * directly; when the engine cannot honor that rate, a windowed-sinc resampler
 * downsamples or upsamples the graph output with an anti-aliasing low-pass
 * instead of dropping samples. No `ScriptProcessor` fallback is carried: the
 * Electron renderer has AudioWorklet, the test harness fakes it, and the
 * deprecated fallback would add a second untested audio path.
 *
 * Segments reach the listener only after the injected word gate accepts them.
 * Muting and stopping release the microphone and discard an open segment.
 * @module @deepseek-ai/dsh-voice-alive/client/audio/capture
 */
import { CaptureError, toCaptureError } from './devices.ts'
import type { CaptureController, SpeechSegment, WordGate } from './types.ts'
import { SAMPLE_RATE, FRAME_SAMPLES, createSegmentDetector, energyWordGate } from './vad.ts'

export { CaptureError } from './devices.ts'
export type { CaptureErrorKind } from './devices.ts'
export type { CaptureChunk, CaptureController, CaptureOptions, SpeechSegment, WordGate } from './types.ts'

/** Processor name registered by the generated worklet module. */
const WORKLET_PROCESSOR = 'dsh-voice-capture'

/**
 * AudioWorklet module source. The processor forwards each 128-frame render
 * block as a transferred `Float32Array`; framing and resampling stay on the
 * main thread where they can be tested without a real audio graph.
 */
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      const block = channel.slice()
      this.port.postMessage(block, [block.buffer])
    }
    return true
  }
}
registerProcessor(${JSON.stringify(WORKLET_PROCESSOR)}, CaptureProcessor)
`

/** Half-width, in source samples, of the resampling interpolation kernel. */
const RESAMPLER_HALF_TAPS = 16

/** One acquisition's audio graph and the disconnect that undoes it. */
interface CaptureRuntime {
  /** Stream source feeding the tap. */
  readonly source: MediaStreamAudioSourceNode
  /** Zero-gain sink that keeps the graph pulled without playing the mic. */
  readonly sink: GainNode
  /** Worklet node and its port cleanup. */
  readonly tap: AudioTap
  /** Aborted on release so finished tracks stop reporting. */
  readonly tracks: AbortController
  /** Disconnect every node, stop the tracks, and close the context. */
  close(): Promise<void>
}

/** The worklet node plus the teardown that silences and disconnects it. */
interface AudioTap {
  /** Node connected between the source and the silent sink. */
  readonly node: AudioNode
  /** Detach the port handler, close the port, and disconnect the node. */
  disconnect(): void
}

/**
 * Convert one normalized float sample to signed 16-bit PCM.
 * @param value - sample in the audio graph's normalized range.
 * @returns the clamped, rounded 16-bit value.
 */
function pcmSample(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value))
  return Math.round(clamped * (clamped < 0 ? 32768 : 32767))
}

/**
 * Streaming band-limited resampler from the context rate to 16 kHz.
 *
 * Output samples are evaluated with a Hann-windowed sinc kernel whose cutoff
 * follows the rate ratio, so downsampling filters before it decimates and
 * upsampling interpolates without aliasing. Each output is normalized by the
 * kernel weight actually available, which keeps direct current and silence
 * exact at both stream edges.
 */
class StreamingResampler {
  /** Source samples per target sample. */
  private readonly ratio: number
  /** Low-pass cutoff in units of the source Nyquist frequency. */
  private readonly cutoff: number
  /** Source history, retained so interpolation always has left context. */
  private readonly source: number[] = []
  /** Fractional source position of the next output sample. */
  private position = 0

  /**
   * @param sourceRate - sample rate of the audio graph output in hertz.
   */
  constructor(sourceRate: number) {
    this.ratio = sourceRate / SAMPLE_RATE
    this.cutoff = Math.min(1, 1 / this.ratio)
  }

  /**
   * Consume one graph block and emit every output sample it completes.
   * @param samples - normalized samples at the source rate.
   * @param emit - receives each normalized sample at 16 kHz.
   */
  write(samples: Float32Array, emit: (value: number) => void): void {
    for (const sample of samples) this.source.push(sample)
    while (Math.floor(this.position) + RESAMPLER_HALF_TAPS < this.source.length) {
      emit(this.sampleAt(this.position))
      this.position += this.ratio
    }
    // Drop history that no future output can reach. Before the position moves
    // past the kernel half-width the amount is zero and the splice is a no-op.
    const drop = Math.max(0, Math.floor(this.position) - RESAMPLER_HALF_TAPS)
    this.source.splice(0, drop)
    this.position -= drop
  }

  /**
   * Interpolate one output sample.
   * @param at - fractional source position.
   * @returns the band-limited sample value at that position.
   */
  private sampleAt(at: number): number {
    const base = Math.floor(at)
    const start = Math.max(0, base - RESAMPLER_HALF_TAPS)
    const window = this.source.slice(start, base + RESAMPLER_HALF_TAPS + 1)
    let tau = at - start
    let value = 0
    let weight = 0
    for (const sample of window) {
      if (tau <= RESAMPLER_HALF_TAPS) {
        const distance = Math.PI * this.cutoff * tau
        const sinc = tau === 0 ? 1 : Math.sin(distance) / distance
        const tap = this.cutoff * sinc * (0.5 + 0.5 * Math.cos((Math.PI * tau) / RESAMPLER_HALF_TAPS))
        value += sample * tap
        weight += tap
      }
      tau -= 1
    }
    return value / weight
  }
}

/**
 * Build the audio context, preferring the requested capture rate.
 * @returns a running context at 16 kHz when the engine accepts the rate,
 * otherwise a default-rate context whose output the resampler converts.
 * @throws CaptureError `unsupported` when the page has no Web Audio API.
 */
function createContext(): AudioContext {
  if (typeof AudioContext === 'undefined') throw new CaptureError('unsupported')
  try {
    return new AudioContext({ sampleRate: SAMPLE_RATE })
  } catch {
    return new AudioContext()
  }
}

/**
 * Acquire the selected microphone.
 * @param deviceId - exact input device id, or undefined for the system default.
 * @returns the acquired stream.
 * @throws CaptureError with the typed platform failure.
 */
async function requestStream(deviceId: string | undefined): Promise<MediaStream> {
  const media = navigator.mediaDevices as MediaDevices | undefined
  if (media === undefined) throw new CaptureError('unsupported')
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    sampleRate: SAMPLE_RATE,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
  if (deviceId !== undefined) audio.deviceId = { exact: deviceId }
  try {
    return await media.getUserMedia({ audio, video: false })
  } catch (error) {
    throw toCaptureError(error)
  }
}

/**
 * Attach the capture worklet.
 * @param context - the audio context that will own the node.
 * @param onSamples - receives each render block as normalized samples.
 * @returns the worklet node and its teardown.
 * @throws CaptureError `unsupported` when AudioWorklet is missing or its
 * module cannot load.
 */
async function openTap(context: AudioContext, onSamples: (samples: Float32Array) => void): Promise<AudioTap> {
  if (typeof AudioWorkletNode !== 'function') throw new CaptureError('unsupported')
  const worklet = context.audioWorklet as AudioWorklet | undefined
  if (worklet === undefined) throw new CaptureError('unsupported')
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
  const loaded = await worklet.addModule(url).then(() => true, () => false)
  URL.revokeObjectURL(url)
  if (!loaded) throw new CaptureError('unsupported')
  const node = new AudioWorkletNode(context, WORKLET_PROCESSOR)
  node.port.onmessage = (event: MessageEvent<Float32Array>) => { onSamples(event.data) }
  return {
    node,
    disconnect: () => {
      node.port.onmessage = null
      node.port.close()
      node.disconnect()
    },
  }
}

/**
 * Open the whole capture graph for one acquisition.
 * @param deviceId - exact input device id, or undefined for the system default.
 * @param onFrame - receives each complete 320-sample frame at 16 kHz.
 * @param onEnded - called once when a captured track ends by itself.
 * @returns the running graph and its teardown.
 */
async function openRuntime(
  deviceId: string | undefined,
  onFrame: (frame: Int16Array) => void,
  onEnded: () => void,
): Promise<CaptureRuntime> {
  const stream = await requestStream(deviceId)
  let context: AudioContext | undefined
  try {
    context = createContext()
    const source = context.createMediaStreamSource(stream)
    const sink = context.createGain()
    sink.gain.value = 0
    const resampler = new StreamingResampler(context.sampleRate)
    let pending = new Int16Array(0)
    const tap = await openTap(context, (samples) => {
      const produced: number[] = []
      resampler.write(samples, (value) => { produced.push(pcmSample(value)) })
      const merged = new Int16Array(pending.length + produced.length)
      merged.set(pending)
      merged.set(produced, pending.length)
      pending = merged
      while (pending.length >= FRAME_SAMPLES) {
        onFrame(pending.slice(0, FRAME_SAMPLES))
        pending = pending.slice(FRAME_SAMPLES)
      }
    })
    source.connect(tap.node)
    tap.node.connect(sink)
    sink.connect(context.destination)
    if (context.state === 'suspended') {
      try {
        // A context created outside a gesture may start suspended; without a
        // successful resume the graph never renders a frame.
        await context.resume()
      } catch (error) {
        throw new CaptureError('unsupported', error)
      }
    }
    const tracks = new AbortController()
    const audioContext = context
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => { onEnded() }, { signal: tracks.signal })
    }
    return {
      source,
      sink,
      tap,
      tracks,
      close: async () => {
        tracks.abort()
        tap.disconnect()
        source.disconnect()
        sink.disconnect()
        for (const track of stream.getTracks()) track.stop()
        await audioContext.close()
      },
    }
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    if (context !== undefined) await context.close()
    throw error
  }
}

/**
 * Close one acquisition, containing teardown failures so capture state stays consistent.
 * @param runtime - the acquisition to close.
 */
async function disposeRuntime(runtime: CaptureRuntime): Promise<void> {
  try {
    await runtime.close()
  } catch (error) {
    console.error('voice capture release failed', error)
  }
}

/** Capture controller implementation; `createCapture` is its only constructor. */
class Capture implements CaptureController {
  private current: CaptureController['state'] = 'idle'
  private runtime: CaptureRuntime | undefined
  private readonly segmenter = createSegmentDetector()
  private readonly segments = new Set<(segment: SpeechSegment) => void>()
  private readonly errors = new Set<(error: CaptureError) => void>()
  private readonly gate: WordGate
  private readonly deviceId: string | undefined
  private generation = 0
  private runner: Promise<void> | undefined
  private wasRunning = false
  private delivery: Promise<void> = Promise.resolve()

  /**
   * @param deviceId - exact input device id, or undefined for the system default.
   * @param gate - decision applied to every closed segment.
   */
  constructor(deviceId: string | undefined, gate: WordGate) {
    this.deviceId = deviceId
    this.gate = gate
  }

  get state(): CaptureController['state'] {
    return this.current
  }

  async start(): Promise<void> {
    if (this.current === 'running' && this.runtime !== undefined) return
    this.current = 'running'
    await this.acquire()
  }

  stop(): void {
    this.generation += 1
    this.current = 'idle'
    this.wasRunning = false
    void this.release()
  }

  setMuted(muted: boolean): void {
    if (muted) {
      if (this.current === 'muted') return
      this.wasRunning = this.current === 'running'
      this.generation += 1
      this.current = 'muted'
      void this.release()
      return
    }
    if (this.current !== 'muted') return
    this.current = 'idle'
    const resume = this.wasRunning
    this.wasRunning = false
    if (resume) void this.start()
  }

  onSegment(listener: (segment: SpeechSegment) => void): () => void {
    this.segments.add(listener)
    return () => { this.segments.delete(listener) }
  }

  onError(listener: (error: CaptureError) => void): () => void {
    this.errors.add(listener)
    return () => { this.errors.delete(listener) }
  }

  /**
   * Join or begin the acquisition loop.
   *
   * A stop or mute during a pending acquisition invalidates its token instead
   * of cancelling the loop, so the loop disposes the stale graph and acquires
   * again whenever the controller still wants to run.
   * @returns after an acquisition matching the current generation is live, or
   * after the loop finds that the controller no longer wants to run.
   */
  private acquire(): Promise<void> {
    if (this.runner !== undefined) return this.runner
    const runner = this.run()
    this.runner = runner
    return runner
  }

  /**
   * Acquire until a live graph matches the current generation.
   * @returns after the loop settles.
   */
  private async run(): Promise<void> {
    try {
      while (this.current === 'running' && this.runtime === undefined) {
        const token = this.generation + 1
        this.generation = token
        try {
          const runtime = await openRuntime(
            this.deviceId,
            (frame) => { this.receive(frame, token) },
            () => { this.fail(new CaptureError('no-device')) },
          )
          if (token !== this.generation) {
            await disposeRuntime(runtime)
            continue
          }
          this.runtime = runtime
        } catch (error) {
          // A stale failure belongs to an acquisition that stop, mute, or a
          // new start already discarded; the next iteration serves the new state.
          if (token === this.generation) this.fail(toCaptureError(error))
        }
      }
    } finally {
      // Cleared before the promise settles so a later start begins a new loop.
      this.runner = undefined
    }
  }

  /**
   * Release the graph and reset segmentation.
   * @returns after every resource is closed.
   */
  private async release(): Promise<void> {
    const runtime = this.runtime
    this.runtime = undefined
    this.segmenter.reset()
    this.delivery = Promise.resolve()
    if (runtime !== undefined) await disposeRuntime(runtime)
  }

  /**
   * Feed one frame to the detector and queue any closed segments for gating.
   * @param frame - one 16 kHz frame.
   * @param token - the acquisition that produced the frame.
   */
  private receive(frame: Int16Array, token: number): void {
    if (token !== this.generation) return
    for (const segment of this.segmenter.push(frame)) this.offer(segment, token)
  }

  /**
   * Run one segment through the word gate and notify listeners serially.
   * @param segment - the segment to decide on.
   * @param token - the acquisition that produced the segment.
   */
  private offer(segment: SpeechSegment, token: number): void {
    this.delivery = this.delivery.then(async () => {
      if (token !== this.generation) return
      let accepted: boolean
      try {
        accepted = await this.gate.accept(segment)
      } catch (error) {
        // A gate that fails after mute or stop belongs to a discarded
        // acquisition; it must not turn the muted state into an error.
        if (token === this.generation) this.fail(toCaptureError(error))
        return
      }
      if (!accepted || token !== this.generation) return
      for (const listener of [...this.segments]) {
        try {
          listener(segment)
        } catch (error) {
          console.error('voice capture segment listener failed', error)
        }
      }
    })
  }

  /**
   * Publish one failure and release the graph.
   * @param error - the typed failure to publish.
   */
  private fail(error: CaptureError): void {
    this.generation += 1
    this.current = 'error'
    void this.release()
    for (const listener of [...this.errors]) {
      try {
        listener(error)
      } catch (inner) {
        console.error('voice capture error listener failed', inner)
      }
    }
  }
}

/**
 * Create a microphone capture controller.
 * @param options - input device selection and the word gate; omitting the gate
 * uses the conservative energy and duration rule from `vad.ts`.
 * @returns a controller that starts idle and releases every resource on stop,
 * mute, or failure.
 */
export function createCapture(options: { deviceId?: string; gate?: WordGate } = {}): CaptureController {
  return new Capture(options.deviceId, options.gate ?? { accept: energyWordGate })
}
