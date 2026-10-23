/** Host TTS engine life cycle, streaming order, cancellation, and typed failures. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, describe, expect, it, vi } from 'vitest'
import { createTtsEngine, spawnWorker, TTS_READY_TIMEOUT_MS } from '../src/engine/tts.ts'
import { TtsError, type TtsChunk, type TtsErrorCode } from '../src/engine/tts-types.ts'
import { FakeSpawner, FIXTURE_WAV } from './fake-tts-worker.ts'

/** Create a temp directory removed after the test. */
async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tts-'))
  onTestFinished(async () => { await import('node:fs/promises').then(fs => fs.rm(directory, { recursive: true, force: true })) })
  return directory
}

/** Yield real event-loop turns until the predicate holds, even under fake timers. */
async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000 && !predicate(); turn++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(predicate()).toBe(true)
}

/** Read one little-endian four-character WAV identifier. */
function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

/** Await a rejection and assert its typed code and message fragment. */
async function expectTtsError(promise: Promise<unknown>, code: TtsErrorCode, message?: string): Promise<void> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(TtsError)
  if (!(error instanceof TtsError)) throw new Error('expected a TtsError rejection')
  expect(error.code).toBe(code)
  if (message !== undefined) expect(error.message).toContain(message)
}

/** Assert the emitted bytes are one complete 24 kHz mono 16-bit PCM WAV. */
function expectWav(wav: ArrayBuffer): void {
  const view = new DataView(wav)
  expect(fourcc(view, 0)).toBe('RIFF')
  expect(view.getUint32(4, true)).toBe(wav.byteLength - 8)
  expect(fourcc(view, 8)).toBe('WAVE')
  expect(fourcc(view, 12)).toBe('fmt ')
  expect(view.getUint32(16, true)).toBe(16)
  expect(view.getUint16(20, true)).toBe(1)
  expect(view.getUint16(22, true)).toBe(1)
  expect(view.getUint32(24, true)).toBe(24_000)
  expect(view.getUint32(28, true)).toBe(48_000)
  expect(view.getUint16(32, true)).toBe(2)
  expect(view.getUint16(34, true)).toBe(16)
  expect(fourcc(view, 36)).toBe('data')
  expect(view.getUint32(40, true)).toBe(wav.byteLength - 44)
}

describe('load and life cycle', () => {
  it('rejects a missing model directory with a typed model failure', async () => {
    const engine = createTtsEngine({ spawn: new FakeSpawner().spawn })
    await expect(engine.load(join(tmpdir(), 'dsh-tts-missing-model'))).rejects.toMatchObject({ code: 'model' })
    expect(engine.status).toBe('error')
  })

  it('stops the previous worker when a replacement load fails', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expect(engine.load(join(tmpdir(), 'dsh-tts-missing-replacement'))).rejects.toMatchObject({ code: 'model' })
    expect(spawner.workers[0]?.killed).toBe(true)
    expect(engine.status).toBe('error')
    await expect(engine.speak({ id: 'no-model', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'not-loaded' })
  })

  it('rejects a model path that is not a directory', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'model.onnx')
    await writeFile(file, 'not a directory')
    const engine = createTtsEngine({ spawn: new FakeSpawner().spawn })
    await expect(engine.load(file)).rejects.toMatchObject({ code: 'model' })
  })

  it('spawns the RunAsNode worker with the resolved model configuration', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory, { voice: 'am_adam' })
    expect(engine.status).toBe('ready')
    const call = spawner.calls[0]
    expect(call?.command).toBe(process.execPath)
    expect(call?.options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(call?.args[0]).toBe('--import')
    expect(call?.args.at(-1)).toBe(JSON.stringify({ modelDirectory: directory, voice: 'am_adam' }))
  })

  it('stops a previous worker before loading another model', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await engine.load(directory, { voice: 'bf_emma' })
    expect(spawner.workers).toHaveLength(2)
    expect(spawner.workers[0]?.killed).toBe(true)
    expect(engine.status).toBe('ready')
  })

  it('refuses concurrent loads and speaks while loading', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ ready: 'never' })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    const loading = engine.load(directory)
    const observed = loading.catch(() => undefined)
    await expect(engine.load(directory)).rejects.toMatchObject({ code: 'not-ready' })
    await expect(engine.speak({ id: 'early', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'not-ready' })
    await flushUntil(() => spawner.workers.length === 1)
    await engine.unload()
    await expect(loading).rejects.toMatchObject({ code: 'readiness' })
    await observed
  })

  it('cancels a load that has not spawned its worker yet', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    const loading = engine.load(directory)
    await engine.unload()
    await expect(loading).rejects.toMatchObject({ code: 'cancelled' })
    expect(engine.status).toBe('unloaded')
    expect(spawner.workers).toHaveLength(0)
  })

  it('unloads the worker and forgets the model', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await engine.unload()
    expect(engine.status).toBe('unloaded')
    expect(spawner.workers[0]?.killed).toBe(true)
    await expect(engine.speak({ id: 'after', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'not-loaded' })
  })

  it('reports a readiness timeout and kills the silent worker', async () => {
    const directory = await tempDirectory()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    const spawner = new FakeSpawner({ ready: 'never' })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    const loading = engine.load(directory)
    const assertion = expect(loading).rejects.toMatchObject({ code: 'readiness' })
    await flushUntil(() => spawner.workers.length === 1)
    await vi.advanceTimersByTimeAsync(TTS_READY_TIMEOUT_MS)
    await assertion
    expect(engine.status).toBe('error')
    expect(spawner.workers[0]?.killed).toBe(true)
  })

  it('reports an early worker exit without diagnostics before readiness', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ ready: 'never' })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    const loading = engine.load(directory)
    await flushUntil(() => spawner.workers.length === 1)
    spawner.workers[0]?.crash('', null)
    await expect(loading).rejects.toMatchObject({ code: 'readiness', message: 'TTS worker stopped before readiness' })
  })

  it('reports an early worker exit with its stderr in the readiness failure', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ ready: 'never' })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    const loading = engine.load(directory)
    await flushUntil(() => spawner.workers.length === 1)
    spawner.workers[0]?.crash('model files are incomplete')
    await expectTtsError(loading, 'readiness', 'incomplete')
    expect(engine.status).toBe('error')
  })
})

describe('speak', () => {
  it('emits ordered sentence chunks with valid WAV bytes', async () => {
    const directory = await tempDirectory()
    const engine = createTtsEngine({ spawn: new FakeSpawner().spawn })
    await engine.load(directory)
    const chunks: TtsChunk[] = []
    await engine.speak({ id: 'reply', text: 'First sentence. Second sentence!' }, (chunk) => { chunks.push(chunk) })
    expect(chunks.map(chunk => chunk.index)).toEqual([0, 1])
    expect(chunks.map(chunk => chunk.text)).toEqual(['First sentence.', 'Second sentence!'])
    expect(chunks.map(chunk => chunk.id)).toEqual(['reply', 'reply'])
    expect(chunks.map(chunk => chunk.durationMs)).toEqual([5, 5])
    for (const chunk of chunks) expectWav(chunk.wav)
    expect(new Uint8Array(chunks[0]?.wav ?? new ArrayBuffer(0))).toEqual(new Uint8Array(FIXTURE_WAV))
  })

  it('emits the first chunk before the reply finishes', async () => {
    const directory = await tempDirectory()
    const release = Promise.withResolvers<undefined>()
    const spawner = new FakeSpawner({
      respond: (request, worker) => {
        if (request.index === 0) { worker.chunk(request); return }
        return release.promise.then(() => { worker.chunk(request) })
      },
    })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const chunks: TtsChunk[] = []
    const speaking = engine.speak({ id: 'stream', text: 'One. Two.' }, (chunk) => { chunks.push(chunk) })
    await flushUntil(() => chunks.length === 1)
    expect(chunks[0]?.text).toBe('One.')
    let settled = false
    void speaking.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve(undefined)
    await speaking
    expect(chunks.map(chunk => chunk.index)).toEqual([0, 1])
  })

  it('uses the request voice over the loaded voice', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory, { voice: 'am_adam' })
    await engine.speak({ id: 'voice', text: 'Hello.' }, () => {})
    await engine.speak({ id: 'override', text: 'Hello.', voice: 'bf_emma' }, () => {})
    expect(spawner.workers[0]?.requests.map(request => request.voice)).toEqual(['am_adam', 'bf_emma'])
  })

  it('rejects empty text and propagates consumer failures', async () => {
    const directory = await tempDirectory()
    const engine = createTtsEngine({ spawn: new FakeSpawner().spawn })
    await engine.load(directory)
    await expect(engine.speak({ id: 'empty', text: '   ' }, () => {})).rejects.toMatchObject({ code: 'input' })
    await expect(engine.speak({ id: 'consumer', text: 'Hello.' }, () => {
      throw new Error('consumer failed')
    })).rejects.toThrow('consumer failed')
    expect(engine.status).toBe('ready')
  })

  it('turns a worker error frame into a typed synthesis failure and keeps the worker', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: (request, worker) => { worker.error('voice is unavailable', request.id) } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expect(engine.speak({ id: 'synthesis', text: 'Hello.' }, () => {})).rejects.toMatchObject({
      code: 'synthesis', message: 'voice is unavailable',
    })
    expect(engine.status).toBe('ready')
  })

  it('accepts an error frame without a request identity', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: (_request, worker) => { worker.error('unknown request') } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expect(engine.speak({ id: 'anonymous', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'synthesis' })
  })

  it('rejects protocol violations and stops the worker', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: (_request, worker) => { worker.write('not-json') } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expect(engine.speak({ id: 'protocol', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'protocol' })
    expect(engine.status).toBe('error')
    expect(spawner.workers[0]?.killed).toBe(true)
  })

  it('rejects a chunk answered for the wrong sentence index', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: (request, worker) => { worker.chunk(request, { index: request.index + 1 }) } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expect(engine.speak({ id: 'wrong-index', text: 'Hello.' }, () => {})).rejects.toMatchObject({
      code: 'protocol',
    })
  })

  it('contains request-stream errors and response-stream failures', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const worker = spawner.workers[0]
    if (worker === undefined) throw new Error('worker missing')
    worker.stdin.emit('error', new Error('broken request stream'))
    await expect(engine.speak({ id: 'still-works', text: 'Hello.' }, () => {})).resolves.toBeUndefined()
    worker.stdout.emit('error', new Error('broken response stream'))
    await vi.waitFor(() => { expect(engine.status).toBe('error') })
    expect(worker.killed).toBe(true)
  })

  it('rejects a broken request stream with a typed worker failure', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const worker = spawner.workers[0]
    if (worker === undefined) throw new Error('worker missing')
    vi.spyOn(worker.stdin, 'write').mockImplementation(() => { throw new Error('closed') })
    await expect(engine.speak({ id: 'closed', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'worker' })
  })

  it('bounds the admitted queue', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: () => { /* hold until cancellation */ } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const admitted = Array.from({ length: 4 }, (_, index) =>
      engine.speak({ id: `p${String(index)}`, text: 'Hello.' }, () => {}))
    await expect(engine.speak({ id: 'overflow', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'queue-full' })
    await flushUntil(() => (spawner.workers[0]?.requests.length ?? 0) === 1)
    engine.cancel()
    await Promise.allSettled(admitted)
  })
})

describe('cancellation', () => {
  it('stops mid-synthesis without emitting a chunk', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: () => { /* never answers */ } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const chunks: TtsChunk[] = []
    const speaking = engine.speak({ id: 'cancel-mid', text: 'Hello.' }, (chunk) => { chunks.push(chunk) })
    await flushUntil(() => (spawner.workers[0]?.requests.length ?? 0) === 1)
    engine.cancel()
    await speaking
    expect(chunks).toEqual([])
    expect(spawner.workers[0]?.killed).toBe(true)
    expect(engine.status).toBe('unloaded')
  })

  it('drops the next chunk when cancelled between sentences', async () => {
    const directory = await tempDirectory()
    const release = Promise.withResolvers<undefined>()
    const spawner = new FakeSpawner({
      respond: (request, worker) => {
        if (request.index === 0) { worker.chunk(request); return }
        return release.promise.then(() => { worker.chunk(request) })
      },
    })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const chunks: TtsChunk[] = []
    const speaking = engine.speak({ id: 'cancel-between', text: 'One. Two.' }, (chunk) => { chunks.push(chunk) })
    await flushUntil(() => chunks.length === 1)
    engine.cancel()
    await speaking
    release.resolve(undefined)
    expect(chunks.map(chunk => chunk.index)).toEqual([0])
  })

  it('leaves an idle worker warm', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    engine.cancel()
    expect(engine.status).toBe('ready')
    expect(spawner.workers[0]?.killed).toBe(false)
  })

  it('keeps a cancelled request from rejecting', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: () => { /* never answers */ } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const speaking = engine.speak({ id: 'resolve', text: 'Hello.' }, () => {})
    await flushUntil(() => (spawner.workers[0]?.requests.length ?? 0) === 1)
    engine.cancel()
    await expect(speaking).resolves.toBeUndefined()
  })
})

describe('worker recovery', () => {
  it('surfaces a crash mid-job and respawns on the next request', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({
      respond: (_request, worker) => { worker.crash('onnx runtime failed') },
    })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expectTtsError(engine.speak({ id: 'crash', text: 'Hello.' }, () => {}), 'worker', 'onnx runtime failed')
    expect(engine.status).toBe('error')
    const chunks: TtsChunk[] = []
    await engine.speak({ id: 'recovered', text: 'Hello.' }, (chunk) => { chunks.push(chunk) })
    expect(chunks).toHaveLength(1)
    expect(spawner.workers).toHaveLength(2)
    expect(engine.status).toBe('ready')
  })

  it('drops a request cancelled while its replacement worker starts', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({}, { ready: 'never' })
    const engine = createTtsEngine({ spawn: spawner.spawn, idleMs: 5 })
    await engine.load(directory)
    await engine.speak({ id: 'warm', text: 'Hello.' }, () => {})
    await vi.waitFor(() => { expect(engine.status).toBe('unloaded') })
    const speaking = engine.speak({ id: 'respawn-cancelled', text: 'Hello.' }, () => {})
    await flushUntil(() => spawner.workers.length === 2)
    engine.cancel()
    await expect(speaking).resolves.toBeUndefined()
    expect(spawner.workers[1]?.killed).toBe(true)
  })

  it('stops an idle worker and respawns it on demand', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn, idleMs: 10 })
    await engine.load(directory)
    await engine.speak({ id: 'warm', text: 'Hello.' }, () => {})
    await vi.waitFor(() => { expect(engine.status).toBe('unloaded') })
    expect(spawner.workers[0]?.killed).toBe(true)
    const chunks: TtsChunk[] = []
    await engine.speak({ id: 'cold', text: 'Hello again.' }, (chunk) => { chunks.push(chunk) })
    expect(chunks).toHaveLength(1)
    expect(spawner.workers).toHaveLength(2)
    expect(engine.status).toBe('ready')
  })

  it('runs the real worker entry and reports a missing model through stderr', async () => {
    const directory = await tempDirectory()
    const engine = createTtsEngine()
    await expectTtsError(engine.load(directory), 'readiness', 'Kokoro model is missing')
    expect(engine.status).toBe('error')
  }, 30_000)

  it('exposes typed errors', () => {
    const error = new TtsError('input', 'no text')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('input')
  })
})

describe('protocol edge cases', () => {
  it.each([
    ['a non-frame array', '[]'],
    ['readiness without a sample rate', JSON.stringify({ type: 'ready' })],
    ['a chunk without payload fields', JSON.stringify({ type: 'chunk', id: 'x', index: 0 })],
    ['an error without a message', JSON.stringify({ type: 'error' })],
    ['an unknown frame type', JSON.stringify({ type: 'mystery' })],
  ])('rejects %s and stops the worker', async (_case, raw) => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    spawner.workers[0]?.write(raw)
    await vi.waitFor(() => { expect(engine.status).toBe('error') })
    expect(spawner.workers[0]?.killed).toBe(true)
  })

  it('rejects a duplicate readiness frame', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    spawner.workers[0]?.ready()
    await vi.waitFor(() => { expect(engine.status).toBe('error') })
    expect(spawner.workers[0]?.killed).toBe(true)
  })

  it('rejects an error frame that names a different request', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: (_request, worker) => { worker.error('unrelated', 'other') } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expect(engine.speak({ id: 'target', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'protocol' })
  })

  it('ignores a blank protocol line', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    spawner.workers[0]?.write('')
    await new Promise(resolve => setImmediate(resolve))
    expect(engine.status).toBe('ready')
    await expect(engine.speak({ id: 'after-blank', text: 'Hello.' }, () => {})).resolves.toBeUndefined()
  })

  it('ignores a frame from a worker that was already replaced', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ keepStreamsOnKill: true }, {})
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const replaced = spawner.workers[0]
    await engine.load(directory)
    replaced?.forceWrite('not-json')
    await new Promise(resolve => setImmediate(resolve))
    expect(engine.status).toBe('ready')
    expect(spawner.workers[1]?.killed).toBe(false)
  })

  it('surfaces a protocol failure during readiness', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ ready: 'never' })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    const loading = engine.load(directory)
    const assertion = expect(loading).rejects.toMatchObject({ code: 'protocol' })
    await flushUntil(() => spawner.workers.length === 1)
    spawner.workers[0]?.write('not-json')
    await assertion
    expect(engine.status).toBe('error')
  })
})

describe('additional life cycle edges', () => {
  it('unloads while a reply is pending and settles it cleanly', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: () => { /* hold */ } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    const speaking = engine.speak({ id: 'pending-unload', text: 'Hello.' }, () => {})
    await flushUntil(() => (spawner.workers[0]?.requests.length ?? 0) === 1)
    await engine.unload()
    await expect(speaking).resolves.toBeUndefined()
    expect(spawner.workers[0]?.killed).toBe(true)
    await expect(engine.speak({ id: 'after-unload', text: 'Hello.' }, () => {})).rejects.toMatchObject({
      code: 'not-loaded',
    })
  })

  it('reports a failed respawn as a readiness failure', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner(
      { respond: (_request, worker) => { worker.crash('first failure') } },
      { ready: 'never' },
    )
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expect(engine.speak({ id: 'first', text: 'Hello.' }, () => {})).rejects.toMatchObject({ code: 'worker' })
    const speaking = engine.speak({ id: 'second', text: 'Hello.' }, () => {})
    await flushUntil(() => spawner.workers.length === 2)
    spawner.workers[1]?.crash('cannot load')
    await expectTtsError(speaking, 'readiness', 'cannot load')
  })

  it('reports an idle crash and drops a request cancelled before its worker starts', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner()
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    spawner.workers[0]?.crash('', null)
    await vi.waitFor(() => { expect(engine.status).toBe('error') })
    const speaking = engine.speak({ id: 'cancelled-before-start', text: 'Hello.' }, () => {})
    engine.cancel()
    await expect(speaking).resolves.toBeUndefined()
    expect(engine.status).toBe('unloaded')
    expect(spawner.workers).toHaveLength(1)
  })

  it('reports a signal exit with an empty diagnostic', async () => {
    const directory = await tempDirectory()
    const spawner = new FakeSpawner({ respond: (_request, worker) => { worker.crash('', null) } })
    const engine = createTtsEngine({ spawn: spawner.spawn })
    await engine.load(directory)
    await expect(engine.speak({ id: 'signal', text: 'Hello.' }, () => {})).rejects.toMatchObject({
      code: 'worker', message: 'TTS worker stopped',
    })
  })

  it('launches and terminates a real default-spawned child', async () => {
    const child = spawnWorker(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env })
    child.stdin.end()
    child.kill()
    await expect(child.done).resolves.toBeNull()
  })

  it('contains a launch failure as a child exit', async () => {
    const child = spawnWorker('/definitely/not/a/dsh-tts-binary', [], { env: {} })
    expect(await child.done).not.toBeNull()
  })
})
