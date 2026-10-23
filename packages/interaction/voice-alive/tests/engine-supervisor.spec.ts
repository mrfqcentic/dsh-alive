/**
 * Engine supervisor: model selection, serialized swaps, bounded independent
 * queues, per-engine restart, crash isolation, health transitions, barge-in,
 * and shutdown. Both engines are in-memory fakes, so no worker child exists.
 */
import { expect, it } from 'vitest'
import { AsrEngineError } from '../src/engine/asr.ts'
import { createEngineSupervisor, SupervisorError } from '../src/engine/supervisor.ts'
import type {
  EngineHealth,
  ModelSelection,
  SupervisorErrorCode,
  SupervisorOptions,
} from '../src/engine/supervisor.ts'
import { TtsError } from '../src/engine/tts-types.ts'
import type { TtsChunk, TtsEngine, TtsRequest, TtsStatus } from '../src/engine/tts-types.ts'
import type { AsrEngine, AsrModelId, AsrRequest, AsrResult, AsrStatus } from '../src/engine/types.ts'

/** One transcription job a test settles by hand. */
interface PendingAsrJob {
  readonly resolve: (result: AsrResult) => void
  readonly reject: (error: unknown) => void
}

/** One reply a test settles by hand. */
interface PendingSpeech {
  readonly onChunk: (chunk: TtsChunk) => void
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

/** In-memory recognizer that records every call and holds jobs until a test settles them. */
class FakeAsr implements AsrEngine {
  model: AsrModelId | null = null
  status: AsrStatus = 'unloaded'
  readonly loads: { id: AsrModelId; directory: string }[] = []
  readonly requests: AsrRequest[] = []
  readonly jobs: PendingAsrJob[] = []
  unloads = 0
  loadError: unknown
  unloadError: unknown
  loadGate: PromiseWithResolvers<undefined> | undefined
  private loading = false

  async load(id: AsrModelId, directory: string): Promise<void> {
    this.loads.push({ id, directory })
    if (this.loadError !== undefined) throw this.loadError
    this.loading = true
    try {
      if (this.loadGate !== undefined) await this.loadGate.promise
    } finally {
      this.loading = false
    }
    this.model = id
    this.status = 'ready'
  }

  async transcribe(request: AsrRequest): Promise<AsrResult> {
    this.requests.push(request)
    const job = Promise.withResolvers<AsrResult>()
    this.jobs.push({ resolve: job.resolve, reject: job.reject })
    return job.promise
  }

  async unload(): Promise<void> {
    this.unloads++
    if (this.unloadError !== undefined) throw this.unloadError
    if (this.loading) throw new AsrEngineError('Cannot unload while an ASR model is loading', 'state')
    for (const job of this.jobs) job.reject(new AsrEngineError('ASR engine unloaded', 'state'))
    this.model = null
    this.status = 'unloaded'
  }
}

/** In-memory synthesizer that holds each reply until a test settles or cancels it. */
class FakeTts implements TtsEngine {
  status: TtsStatus = 'unloaded'
  readonly loads: { directory: string; voice: string | undefined }[] = []
  readonly requests: TtsRequest[] = []
  readonly jobs: PendingSpeech[] = []
  unloads = 0
  cancels = 0
  loadError: unknown
  unloadError: unknown
  loadGate: PromiseWithResolvers<undefined> | undefined

  async load(directory: string, options: { voice?: string } = {}): Promise<void> {
    this.loads.push({ directory, voice: options.voice })
    if (this.loadError !== undefined) throw this.loadError
    if (this.loadGate !== undefined) await this.loadGate.promise
    this.status = 'ready'
  }

  async speak(request: TtsRequest, onChunk: (chunk: TtsChunk) => void): Promise<void> {
    this.requests.push(request)
    const job = Promise.withResolvers<undefined>()
    this.jobs.push({ onChunk, resolve: () => { job.resolve(undefined) }, reject: job.reject })
    return job.promise
  }

  cancel(): void {
    this.cancels++
    // The engine ends the in-flight reply; the supervisor decides what a
    // cancelled reply reports.
    for (const job of this.jobs) job.resolve()
  }

  async unload(): Promise<void> {
    this.unloads++
    if (this.unloadError !== undefined) throw this.unloadError
    for (const job of this.jobs) job.resolve()
    this.status = 'unloaded'
  }
}

const WHISPER: ModelSelection['asr'] = { id: 'whisper', directory: '/models/whisper' }
const PARAKEET: ModelSelection['asr'] = { id: 'parakeet', directory: '/models/parakeet' }
const KOKORO: ModelSelection['tts'] = { directory: '/models/kokoro', voice: 'af_heart' }
const KOKORO_DEFAULT: ModelSelection['tts'] = { directory: '/models/kokoro-default' }

function fixture(options: Partial<SupervisorOptions> = {}): {
  supervisor: ReturnType<typeof createEngineSupervisor>
  asr: FakeAsr
  tts: FakeTts
} {
  const asr = new FakeAsr()
  const tts = new FakeTts()
  const supervisor = createEngineSupervisor({ asr, tts, ...options })
  return { supervisor, asr, tts }
}

function request(id: string): AsrRequest {
  return { id, pcm: new Int16Array([1, -2, 3]), sampleRate: 16000 }
}

function speakRequest(id: string): TtsRequest {
  return { id, text: 'Hello there.' }
}

function chunk(id: string): TtsChunk {
  return { id, index: 0, wav: new ArrayBuffer(2), text: 'Hello there.', durationMs: 4 }
}

/** Yield real event-loop turns so queued lane tasks start. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => { throw new Error('expected the operation to reject') },
    (error: unknown) => error,
  )
}

async function expectSupervisorError(
  operation: Promise<unknown>,
  code: SupervisorErrorCode,
): Promise<SupervisorError> {
  const error = await rejection(operation)
  expect(error).toBeInstanceOf(SupervisorError)
  if (!(error instanceof SupervisorError)) throw new Error('expected a SupervisorError rejection')
  expect(error.code).toBe(code)
  return error
}

function unloadedHealth(): EngineHealth {
  return { status: 'unloaded', lastErrorCode: null, lastSuccessAt: null, restarts: 0 }
}

it('starts unconfigured, unloaded, and refuses work on either engine', async () => {
  const { supervisor } = fixture()
  expect(supervisor.ready).toBe(false)
  expect(supervisor.health).toEqual({ asr: unloadedHealth(), tts: unloadedHealth() })
  await expectSupervisorError(supervisor.transcribe(request('early')), 'not-configured')
  await expectSupervisorError(supervisor.speak(speakRequest('early'), () => {}), 'not-configured')
})

it('configures both engines with their selected models and reports readiness', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  expect(asr.loads).toEqual([{ id: 'whisper', directory: '/models/whisper' }])
  expect(tts.loads).toEqual([{ directory: '/models/kokoro', voice: 'af_heart' }])
  expect(supervisor.ready).toBe(true)
  const health = supervisor.health
  expect(health.asr).toMatchObject({ status: 'ready', lastErrorCode: null })
  expect(health.tts).toMatchObject({ status: 'ready', lastErrorCode: null })
  expect(health.asr.lastSuccessAt).toEqual(expect.any(Number))
  expect(health.tts.lastSuccessAt).toEqual(expect.any(Number))
  expect(health.asr.restarts).toBe(0)
})

it('treats the omitted voice as part of the selection and skips an unchanged ready model', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO_DEFAULT })
  await supervisor.configure({ asr: WHISPER, tts: KOKORO_DEFAULT })
  expect(asr.loads).toHaveLength(1)
  expect(tts.loads).toHaveLength(1)
  expect(tts.loads[0]).toEqual({ directory: '/models/kokoro-default', voice: undefined })
  await supervisor.configure({ asr: WHISPER, tts: { directory: '/models/kokoro-default', voice: 'af_heart' } })
  expect(tts.loads).toHaveLength(2)
  expect(tts.loads[1]).toEqual({ directory: '/models/kokoro-default', voice: 'af_heart' })
})

it('unloads an engine whose selection is null and refuses its work afterwards', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  await supervisor.configure({ asr: null, tts: null })
  expect(asr.unloads).toBe(1)
  expect(tts.unloads).toBe(1)
  expect(supervisor.health.asr.status).toBe('unloaded')
  expect(supervisor.health.tts.status).toBe('unloaded')
  expect(supervisor.ready).toBe(false)
  await expectSupervisorError(supervisor.transcribe(request('late')), 'not-configured')
  await expectSupervisorError(supervisor.speak(speakRequest('late'), () => {}), 'not-configured')
})

it('swaps an idle model on each engine independently', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  await supervisor.configure({ asr: PARAKEET, tts: KOKORO_DEFAULT })
  expect(asr.loads.map(call => call.id)).toEqual(['whisper', 'parakeet'])
  expect(tts.loads.map(call => call.directory)).toEqual(['/models/kokoro', '/models/kokoro-default'])
  expect(supervisor.ready).toBe(true)
})

it('applies a swap only after the in-flight job on that engine finishes', async () => {
  const { supervisor, asr } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const job = supervisor.transcribe(request('busy'))
  await flush()
  expect(asr.requests).toHaveLength(1)
  const swap = supervisor.configure({ asr: PARAKEET, tts: KOKORO })
  await flush()
  expect(asr.loads).toHaveLength(1)
  const pending = asr.jobs[0]
  expect(pending).toBeDefined()
  pending?.resolve({ id: 'busy', text: 'busy', durationMs: 3, model: 'whisper' })
  await expect(job).resolves.toMatchObject({ text: 'busy', model: 'whisper' })
  await swap
  expect(asr.loads).toHaveLength(2)
  expect(supervisor.health.asr.status).toBe('ready')
  expect(supervisor.health.asr.lastErrorCode).toBeNull()
})

it('leaves a failed load explicitly unloaded instead of keeping the previous model', async () => {
  const { supervisor, asr } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  asr.loadError = new AsrEngineError('ASR model directory does not exist', 'model-not-found')
  const error = await expectSupervisorError(supervisor.configure({ asr: PARAKEET, tts: KOKORO }), 'load-failed')
  expect(error.message).toContain('model-not-found')
  expect(error.cause).toBeInstanceOf(SupervisorError)
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'model-not-found' })
  expect(supervisor.ready).toBe(false)
  await expectSupervisorError(supervisor.transcribe(request('after-failure')), 'not-configured')
  expect(supervisor.health.tts.status).toBe('ready')
  asr.loadError = undefined
  await supervisor.configure({ asr: PARAKEET, tts: KOKORO })
  expect(supervisor.health.asr.status).toBe('ready')
  expect(supervisor.ready).toBe(true)
})

it('reports every engine that failed one configure attempt', async () => {
  const { supervisor, asr, tts } = fixture()
  asr.loadError = new AsrEngineError('ASR weights are unreadable', 'model-incompatible')
  tts.loadError = new TtsError('model', 'TTS model directory does not exist')
  const error = await expectSupervisorError(supervisor.configure({ asr: WHISPER, tts: KOKORO }), 'load-failed')
  expect(error.message).toContain('ASR weights are unreadable')
  expect(error.message).toContain('TTS model directory does not exist')
  expect(error.cause).toBeInstanceOf(SupervisorError)
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'model-incompatible' })
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'model' })
})

it('records an engine error when an unload fails', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  asr.unloadError = new AsrEngineError('ASR engine is busy', 'state')
  tts.unloadError = new TtsError('worker', 'TTS worker refused to stop')
  const error = await expectSupervisorError(supervisor.configure({ asr: null, tts: null }), 'load-failed')
  expect(error.message).toContain('ASR engine could not unload')
  expect(error.message).toContain('TTS engine could not unload')
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'state' })
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'worker' })
})

it('records untyped load, unload, and restart failures as internal', async () => {
  const { supervisor, asr, tts } = fixture()
  tts.loadError = new Error('TTS load exploded')
  await expectSupervisorError(supervisor.configure({ asr: WHISPER, tts: KOKORO }), 'load-failed')
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'internal' })
  tts.loadError = undefined
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  asr.unloadError = new Error('ASR unload exploded')
  tts.unloadError = new Error('TTS unload exploded')
  await expectSupervisorError(supervisor.configure({ asr: null, tts: null }), 'load-failed')
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'internal' })
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'internal' })

  asr.unloadError = undefined
  tts.unloadError = undefined
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  asr.unloadError = new Error('ASR restart exploded')
  await expectSupervisorError(supervisor.restart('asr'), 'load-failed')
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'internal' })

  tts.unloadError = new Error('TTS restart exploded')
  await expectSupervisorError(supervisor.restart('tts'), 'load-failed')
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'internal' })
})

it('restarts only the requested engine from its applied selection', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  await supervisor.restart('asr')
  expect(asr.unloads).toBe(1)
  expect(asr.loads).toEqual([
    { id: 'whisper', directory: '/models/whisper' },
    { id: 'whisper', directory: '/models/whisper' },
  ])
  expect(tts.unloads).toBe(0)
  expect(tts.loads).toHaveLength(1)
  expect(supervisor.health.asr.restarts).toBe(1)
  expect(supervisor.health.tts.restarts).toBe(0)
  expect(supervisor.health.asr.status).toBe('ready')
  await supervisor.restart('tts')
  expect(tts.unloads).toBe(1)
  expect(tts.loads).toHaveLength(2)
  expect(supervisor.health.tts.restarts).toBe(1)
})

it('restarts an unconfigured engine into an explicitly unloaded state', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.restart('asr')
  await supervisor.restart('tts')
  expect(asr.loads).toHaveLength(0)
  expect(tts.loads).toHaveLength(0)
  expect(supervisor.health.asr).toEqual({
    status: 'unloaded', lastErrorCode: null, lastSuccessAt: null, restarts: 1,
  })
  expect(supervisor.health.tts.restarts).toBe(1)
})

it('records a failed restart and never restores the previous model', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  asr.loadError = 'the worker refused to load'
  const error = await expectSupervisorError(supervisor.restart('asr'), 'load-failed')
  expect(error.message).toContain('the worker refused to load')
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'internal' })
  expect(supervisor.health.asr.restarts).toBe(1)
  await expectSupervisorError(supervisor.transcribe(request('after-restart')), 'not-configured')

  asr.loadError = undefined
  asr.unloadError = new AsrEngineError('ASR engine is busy', 'state')
  await expectSupervisorError(supervisor.restart('asr'), 'load-failed')
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'state' })

  tts.unloadError = new TtsError('worker', 'TTS worker will not stop')
  await expectSupervisorError(supervisor.restart('tts'), 'load-failed')
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'worker' })
})

it('contains a crashed recognizer to its own engine and recovers on the next job', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const crashed = supervisor.transcribe(request('crash'))
  await flush()
  asr.jobs[0]?.reject(new AsrEngineError('ASR worker exited with code 1', 'crashed'))
  expect(await rejection(crashed)).toBeInstanceOf(AsrEngineError)
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'crashed' })
  expect(supervisor.health.tts.status).toBe('ready')
  expect(supervisor.ready).toBe(false)

  const spoken = supervisor.speak(speakRequest('other-engine'), () => {})
  await flush()
  tts.jobs[0]?.resolve()
  await spoken
  expect(supervisor.health.tts.lastSuccessAt).toEqual(expect.any(Number))

  const recovered = supervisor.transcribe(request('recovered'))
  await flush()
  asr.jobs[1]?.resolve({ id: 'recovered', text: 'ok', durationMs: 2, model: 'whisper' })
  await expect(recovered).resolves.toEqual({ id: 'recovered', text: 'ok', durationMs: 2, model: 'whisper' })
  expect(supervisor.health.asr.status).toBe('ready')
  expect(supervisor.ready).toBe(true)
})

it('records a synthesizer failure and reloads the same model when reconfigured', async () => {
  const { supervisor, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const spoken = supervisor.speak(speakRequest('broken'), () => {})
  await flush()
  tts.jobs[0]?.reject(new TtsError('worker', 'TTS worker stopped'))
  expect(await rejection(spoken)).toBeInstanceOf(TtsError)
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'worker' })
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  expect(tts.loads).toHaveLength(2)
  expect(supervisor.health.tts.status).toBe('ready')
})

it('bounds each engine queue independently and rejects over capacity', async () => {
  const { supervisor, asr, tts } = fixture({ maxQueue: 1 })
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const running = supervisor.transcribe(request('asr-running'))
  await flush()
  const waiting = supervisor.transcribe(request('asr-waiting'))
  const full = await expectSupervisorError(supervisor.transcribe(request('asr-over')), 'queue-full')
  expect(full.message).toContain('maxQueue=1')
  expect(supervisor.health.asr.status).toBe('ready')

  const speaking = supervisor.speak(speakRequest('tts-running'), () => {})
  await flush()
  const speechWaiting = supervisor.speak(speakRequest('tts-waiting'), () => {})
  const speechFull = await expectSupervisorError(supervisor.speak(speakRequest('tts-over'), () => {}), 'queue-full')
  expect(speechFull.message).toContain('TTS queue is full')

  tts.jobs[0]?.resolve()
  await flush()
  tts.jobs[1]?.resolve()
  await expect(speaking).resolves.toBeUndefined()
  await expect(speechWaiting).resolves.toBeUndefined()

  asr.jobs[0]?.resolve({ id: 'asr-running', text: 'one', durationMs: 1, model: 'whisper' })
  await flush()
  asr.jobs[1]?.resolve({ id: 'asr-waiting', text: 'two', durationMs: 1, model: 'whisper' })
  await expect(running).resolves.toMatchObject({ text: 'one' })
  await expect(waiting).resolves.toMatchObject({ text: 'two' })
})

it('cancels queued and in-flight speech for barge-in', async () => {
  const { supervisor, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const spoken: TtsChunk[] = []
  const running = supervisor.speak(speakRequest('first'), value => spoken.push(value))
  await flush()
  const waiting = supervisor.speak(speakRequest('second'), value => spoken.push(value))
  expect(tts.requests).toHaveLength(1)

  supervisor.cancelSpeech()
  expect(tts.cancels).toBe(1)
  await expect(running).resolves.toBeUndefined()
  await flush()
  await expect(waiting).resolves.toBeUndefined()
  expect(tts.requests).toHaveLength(1)
  expect(spoken).toEqual([])
  expect(supervisor.health.tts).toMatchObject({ status: 'ready', lastErrorCode: null })
})

it('swallows a worker failure that races barge-in or shutdown', async () => {
  const { supervisor, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const cancelled = supervisor.speak(speakRequest('race'), () => {})
  await flush()
  tts.jobs[0]?.reject(new TtsError('worker', 'TTS worker stopped during cancellation'))
  supervisor.cancelSpeech()
  await expect(cancelled).resolves.toBeUndefined()
  expect(supervisor.health.tts).toMatchObject({ status: 'ready', lastErrorCode: null })

  const failed = supervisor.speak(speakRequest('shutdown-race'), () => {})
  await flush()
  tts.jobs[1]?.reject(new TtsError('worker', 'TTS worker stopped while unloading'))
  const shutdown = supervisor.shutdown()
  await expect(failed).resolves.toBeUndefined()
  await shutdown
  expect(supervisor.health.tts).toMatchObject({ status: 'shut-down', lastErrorCode: null })
})

it('streams chunks and records the successful reply', async () => {
  const { supervisor, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const received: TtsChunk[] = []
  const spoken = supervisor.speak(speakRequest('hello'), value => received.push(value))
  await flush()
  const pending = tts.jobs[0]
  expect(pending).toBeDefined()
  pending?.onChunk(chunk('hello'))
  pending?.resolve()
  await spoken
  expect(received).toEqual([chunk('hello')])
  expect(supervisor.health.tts.lastSuccessAt).toEqual(expect.any(Number))
})

it('does not mark a healthy engine on a caller-input failure', async () => {
  const { supervisor, asr, tts } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const spoken = supervisor.speak(speakRequest('empty'), () => {})
  await flush()
  tts.jobs[0]?.reject(new TtsError('input', 'TTS text is empty'))
  expect(await rejection(spoken)).toBeInstanceOf(TtsError)
  expect(supervisor.health.tts.status).toBe('ready')
  expect(supervisor.health.tts.lastErrorCode).toBeNull()

  const transcribed = supervisor.transcribe(request('bad-input'))
  await flush()
  asr.jobs[0]?.reject(new AsrEngineError('PCM is malformed', 'invalid-input'))
  expect(await rejection(transcribed)).toBeInstanceOf(AsrEngineError)
  expect(supervisor.health.asr.status).toBe('ready')
})

it('records an untyped job failure as internal without inventing a code', async () => {
  const { supervisor, asr } = fixture()
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const transcribed = supervisor.transcribe(request('untyped'))
  await flush()
  asr.jobs[0]?.reject('not an engine error')
  expect(await rejection(transcribed)).toBe('not an engine error')
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'internal' })
})

it('shuts down during work, settles every pending operation, and stays idempotent', async () => {
  const { supervisor, asr, tts } = fixture({ maxQueue: 2 })
  await supervisor.configure({ asr: WHISPER, tts: KOKORO })
  const running = supervisor.transcribe(request('running'))
  await flush()
  const queued = supervisor.transcribe(request('queued'))
  const restart = supervisor.restart('asr')
  const speaking = supervisor.speak(speakRequest('reply'), () => {})
  await flush()

  const shutdown = supervisor.shutdown()
  expect(await rejection(running)).toBeInstanceOf(AsrEngineError)
  await expectSupervisorError(queued, 'shutting-down')
  await expectSupervisorError(restart, 'shutting-down')
  await expect(speaking).resolves.toBeUndefined()
  await shutdown

  expect(asr.unloads).toBeGreaterThanOrEqual(1)
  expect(tts.unloads).toBeGreaterThanOrEqual(1)
  expect(supervisor.health.asr.status).toBe('shut-down')
  expect(supervisor.health.tts.status).toBe('shut-down')
  expect(supervisor.ready).toBe(false)
  await expectSupervisorError(supervisor.transcribe(request('after')), 'shutting-down')
  await expectSupervisorError(supervisor.speak(speakRequest('after'), () => {}), 'shutting-down')
  await expectSupervisorError(supervisor.configure({ asr: WHISPER, tts: KOKORO }), 'shutting-down')
  await expectSupervisorError(supervisor.restart('asr'), 'shutting-down')
  expect(supervisor.shutdown()).toBe(shutdown)
  supervisor.cancelSpeech()
  expect(tts.cancels).toBe(0)
})

it('waits for an in-flight model load before stopping the engine', async () => {
  const { supervisor, asr } = fixture()
  const gate = Promise.withResolvers<undefined>()
  asr.loadGate = gate
  const configuring = supervisor.configure({ asr: WHISPER, tts: null })
  await flush()
  expect(supervisor.health.asr.status).toBe('loading')
  expect(supervisor.ready).toBe(false)

  const shutdown = supervisor.shutdown()
  await flush()
  gate.resolve(undefined)
  await shutdown
  await expectSupervisorError(configuring, 'shutting-down')
  expect(asr.loads).toHaveLength(1)
  expect(asr.unloads).toBe(2)
  expect(supervisor.health.asr.status).toBe('shut-down')
})

it('reports an engine that refuses to stop', async () => {
  const { supervisor, asr } = fixture()
  asr.unloadError = new Error('unload exploded')
  const error = await expectSupervisorError(supervisor.shutdown(), 'shutdown-failed')
  expect(error.message).toContain('unload exploded')
  expect(supervisor.health.asr).toMatchObject({ status: 'error', lastErrorCode: 'internal' })
  expect(supervisor.health.tts.status).toBe('shut-down')
  await expectSupervisorError(supervisor.shutdown(), 'shutdown-failed')
})

it('reports a synthesizer that refuses to stop', async () => {
  const { supervisor, tts } = fixture()
  tts.unloadError = new TtsError('worker', 'TTS worker is wedged')
  const error = await expectSupervisorError(supervisor.shutdown(), 'shutdown-failed')
  expect(error.message).toContain('TTS worker is wedged')
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'worker' })
  expect(supervisor.health.asr.status).toBe('shut-down')
})

it('records an untyped synthesizer stop failure as internal', async () => {
  const { supervisor, tts } = fixture()
  tts.unloadError = new Error('TTS worker will not stop')
  await expectSupervisorError(supervisor.shutdown(), 'shutdown-failed')
  expect(supervisor.health.tts).toMatchObject({ status: 'error', lastErrorCode: 'internal' })
})

it('rejects an invalid queue bound at construction', () => {
  expect(() => createEngineSupervisor({ maxQueue: 0 })).toThrow(SupervisorError)
  expect(() => createEngineSupervisor({ maxQueue: 1.5 })).toThrow(/positive integer/)
  expect(() => createEngineSupervisor({ maxQueue: -2 })).toThrow(SupervisorError)
})

it('builds the real engines when a caller injects none', () => {
  const supervisor = createEngineSupervisor()
  expect(supervisor.health).toEqual({ asr: unloadedHealth(), tts: unloadedHealth() })
  expect(supervisor.ready).toBe(false)
})
