/** Deterministic capture and playback doubles for audio state machine tests; no hardware is touched. */
import { vi, type Mock } from 'vitest'
import { CaptureError } from '../src/client/audio/devices.ts'
import type { PlaybackChunk, PlaybackController, PlaybackState } from '../src/client/audio/playback.ts'
import type { CaptureController, SpeechSegment } from '../src/client/audio/types.ts'

/** Capture lifecycle state exposed by the fake controller. */
export type FakeCaptureState = CaptureController['state']

/** One fake capture controller and the test-side controls for it. */
export interface FakeCapture {
  readonly controller: CaptureController
  readonly start: Mock<() => Promise<void>>
  readonly stop: Mock<() => void>
  readonly setMuted: Mock<(muted: boolean) => void>
  /** Acquisition state the controller reports; tests may set it directly. */
  state: FakeCaptureState
  /** Deliver one accepted segment to every registered listener. */
  emitSegment(segment: SpeechSegment): void
  /** Deliver one capture failure to every registered listener. */
  emitError(error?: CaptureError): void
  /** Number of listeners capture currently has, one per registration call. */
  readonly segmentListeners: number
  /** Number of failure listeners capture currently has. */
  readonly errorListeners: number
}

/**
 * Build a capture controller whose lifecycle and delivery are test-driven.
 * @returns the fake controller with its mocks and emitters.
 */
export function createFakeCapture(): FakeCapture {
  let current: FakeCaptureState = 'idle'
  const segments = new Set<(segment: SpeechSegment) => void>()
  const errors = new Set<(error: CaptureError) => void>()
  const start = vi.fn(async () => { current = 'running' })
  const stop = vi.fn(() => { current = 'idle' })
  const setMuted = vi.fn((muted: boolean) => {
    current = muted ? 'muted' : current === 'muted' ? 'idle' : current
  })
  const controller: CaptureController = {
    get state() { return current },
    start,
    stop,
    setMuted,
    onSegment(listener) {
      segments.add(listener)
      return () => { segments.delete(listener) }
    },
    onError(listener) {
      errors.add(listener)
      return () => { errors.delete(listener) }
    },
  }
  return {
    controller,
    start,
    stop,
    setMuted,
    get state() { return current },
    set state(next) { current = next },
    emitSegment(segment) { for (const listener of [...segments]) listener(segment) },
    emitError(error = new CaptureError('no-device')) { for (const listener of [...errors]) listener(error) },
    get segmentListeners() { return segments.size },
    get errorListeners() { return errors.size },
  }
}

/** One fake player and the test-side controls for its queue and level. */
export interface FakePlayback {
  readonly controller: PlaybackController
  readonly enqueued: PlaybackChunk[]
  readonly stop: Mock<() => void>
  /** Set the level `getLevel` reports. */
  setLevel(level: number): void
  /** Resolve the active run as if the queue played out. */
  drain(): void
  /** Reject the active run with one failure. */
  fail(error: unknown): void
  /** Whether a run is currently unsettled. */
  readonly running: boolean
}

/** @returns an `Error` whose name is the playback failure discriminator. */
export function namedError(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

/** One in-flight playback run. */
interface FakeRun {
  readonly promise: Promise<undefined>
  readonly resolve: (value: undefined) => void
  readonly reject: (error: unknown) => void
}

/**
 * Build a playback controller whose queue is settled by the test.
 * @returns the fake controller with its mocks and queue controls.
 */
export function createFakePlayback(): FakePlayback {
  const enqueued: PlaybackChunk[] = []
  let run: FakeRun | null = null
  let level = 0
  const stop = vi.fn(() => {
    const active = run
    run = null
    if (active !== null) active.reject(namedError('AbortError'))
  })
  const controller: PlaybackController = {
    enqueue(chunk) {
      enqueued.push(chunk)
      if (run === null) {
        const pending = Promise.withResolvers<undefined>()
        // Callers may enqueue without observing idle; a stop must not be unhandled.
        void pending.promise.catch(() => undefined)
        run = { promise: pending.promise, resolve: pending.resolve, reject: pending.reject }
      }
    },
    get idle() { return run?.promise ?? Promise.resolve() },
    stop,
    setOutputDevice: async () => {},
    getLevel: () => level,
    get state(): PlaybackState {
      return { playing: run !== null, queued: run === null ? 0 : enqueued.length, level, deviceId: null }
    },
    onChange: () => () => {},
    createEchoReference: () => null,
  }
  return {
    controller,
    enqueued,
    stop,
    setLevel(next) { level = next },
    drain() {
      const active = run
      run = null
      if (active !== null) active.resolve(undefined)
    },
    fail(error) {
      const active = run
      run = null
      if (active !== null) active.reject(error)
    },
    get running() { return run !== null },
  }
}

/**
 * Build one closed speech segment.
 * @param id - segment id; defaults to 0.
 * @param overrides - fields to replace in the fixture.
 * @returns the segment.
 */
export function speechSegment(id = 0, overrides: Partial<SpeechSegment> = {}): SpeechSegment {
  return {
    id,
    pcm: new Int16Array(320),
    startedAt: 0,
    endedAt: 400,
    peak: 0.5,
    rms: 0.2,
    ...overrides,
  }
}

/**
 * Build one reply chunk.
 * @param id - chunk id used in assertions.
 * @returns the chunk with empty WAV bytes.
 */
export function playbackChunk(id: string): PlaybackChunk {
  return { id, wav: new ArrayBuffer(0) }
}
