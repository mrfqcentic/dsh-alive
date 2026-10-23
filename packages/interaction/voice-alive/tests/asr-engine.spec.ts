/**
 * ASR engine lifecycle: serial queueing, bounded admission, idle reclamation,
 * crash isolation, protocol failures, and shutdown. The spawned child is a
 * protocol-speaking fake, so no native model or real process is involved.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AsrEngineError, createAsrEngine } from '../src/engine/asr.ts'
import type { AsrEngine, AsrEngineOptions, AsrRequest, AsrWorkerCommand } from '../src/engine/types.ts'
import { createFakeSpawn, FakeWorker, type FakeSpawner } from './support/fake-worker.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function modelDirectory(files: readonly string[] = ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']):
Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-asr-model-'))
  directories.push(directory)
  for (const file of files) await writeFile(join(directory, file), '')
  return directory
}

function fixture(options: Partial<AsrEngineOptions> = {}, ...workers: FakeWorker[]): {
  engine: AsrEngine
  spawner: FakeSpawner
} {
  const spawner = createFakeSpawn(...workers)
  const engine = createAsrEngine({ idleMs: 0, spawn: spawner.spawn, ...options })
  return { engine, spawner }
}

function request(id: string, pcm: Int16Array = new Int16Array([1, -2, 3])): AsrRequest {
  return { id, pcm, sampleRate: 16000 }
}

async function rejection(operation: Promise<unknown>): Promise<AsrEngineError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof AsrEngineError) return error
    throw error
  }
  throw new Error('expected the operation to reject')
}

function transcribeCommands(worker: FakeWorker): Extract<AsrWorkerCommand, { type: 'transcribe' }>[] {
  return worker.commands.filter((command): command is Extract<AsrWorkerCommand, { type: 'transcribe' }> =>
    command.type === 'transcribe')
}

it('starts unloaded and refuses transcription before a model is loaded', async () => {
  const { engine, spawner } = fixture()
  expect(engine.status).toBe('unloaded')
  expect(engine.model).toBeNull()
  expect((await rejection(engine.transcribe(request('early')))).code).toBe('state')
  expect(spawner.calls).toHaveLength(0)
})

it('rejects a missing model directory before spawning a worker', async () => {
  const { engine, spawner } = fixture()
  const error = await rejection(engine.load('whisper', join(tmpdir(), 'dsh-asr-absent-directory')))
  expect(error.code).toBe('model-not-found')
  expect(error.message).toContain('does not exist')
  expect(spawner.calls).toHaveLength(0)
  expect(engine.status).toBe('error')
  expect(engine.model).toBeNull()
})

it('rejects a model path that is not a directory', async () => {
  const directory = await modelDirectory()
  const file = join(directory, 'model.onnx')
  await writeFile(file, '')
  const { engine, spawner } = fixture()
  const error = await rejection(engine.load('whisper', file))
  expect(error.code).toBe('model-incompatible')
  expect(error.message).toContain('not a directory')
  expect(spawner.calls).toHaveLength(0)
})

it('rejects a model path that cannot be read', async () => {
  const { engine } = fixture()
  const error = await rejection(engine.load('whisper', '\0invalid'))
  expect(error.code).toBe('model-incompatible')
  expect(error.message).toContain('cannot be read')
})

it('loads one model over the dedicated protocol channel', async () => {
  const worker = new FakeWorker()
  const { engine, spawner } = fixture({}, worker)
  const directory = await modelDirectory()
  await engine.load('whisper', directory)
  expect(engine.status).toBe('ready')
  expect(engine.model).toBe('whisper')
  expect(spawner.calls).toHaveLength(1)
  const call = spawner.calls[0]
  expect(call?.command).toBe(process.execPath)
  expect(call?.args.at(-1)).toMatch(/asr-worker\.ts$/u)
  expect(call?.options.env.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(call?.options.cwd).toBe(process.cwd())
  expect(worker.lastCommand).toEqual({ type: 'load', id: 'load-1', model: 'whisper', modelDirectory: directory })
})

it('keeps the loaded model when asked for the same directory again', async () => {
  const worker = new FakeWorker()
  const { engine, spawner } = fixture({}, worker)
  const directory = await modelDirectory()
  await engine.load('whisper', directory)
  await engine.load('whisper', directory)
  expect(spawner.calls).toHaveLength(1)
  expect(worker.commands).toHaveLength(1)
})

it('switches models by stopping the old child before loading the next', async () => {
  const first = new FakeWorker()
  const second = new FakeWorker()
  const { engine, spawner } = fixture({}, first, second)
  const whisperDirectory = await modelDirectory()
  const parakeetDirectory = await modelDirectory(['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'])
  await engine.load('whisper', whisperDirectory)
  await engine.load('parakeet', parakeetDirectory)
  expect(engine.model).toBe('parakeet')
  expect(spawner.calls).toHaveLength(2)
  expect(first.commands.map(command => command.type)).toEqual(['load', 'shutdown'])
  expect(first.killSignals).toEqual([])
  expect(second.lastCommand).toMatchObject({ type: 'load', model: 'parakeet', modelDirectory: parakeetDirectory })
})

it('surfaces a worker load failure as a typed model error', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') {
        fake.send({ type: 'error', id: command.id, code: 'model-incompatible', message: 'weights are corrupt' })
      } else if (command.type === 'shutdown') {
        fake.respond(command)
      }
    },
  })
  const { engine } = fixture({}, worker)
  const directory = await modelDirectory()
  const error = await rejection(engine.load('whisper', directory))
  expect(error.code).toBe('model-incompatible')
  expect(error.message).toBe('weights are corrupt')
  expect(engine.status).toBe('error')
  expect(engine.model).toBeNull()
  expect(worker.commands.map(command => command.type)).toEqual(['load', 'shutdown'])
})

it('bounds the readiness handshake instead of hanging', async () => {
  const worker = new FakeWorker({ hello: false })
  const { engine } = fixture({ readinessTimeoutMs: 10 }, worker)
  const directory = await modelDirectory()
  const error = await rejection(engine.load('whisper', directory))
  expect(error.code).toBe('timeout')
  expect(error.message).toContain('readiness')
  expect(worker.commands.map(command => command.type)).toEqual(['shutdown'])
  expect(engine.status).toBe('error')
})

it('rejects a worker that speaks another protocol version', async () => {
  const worker = new FakeWorker({ protocol: 2 })
  const { engine } = fixture({}, worker)
  const directory = await modelDirectory()
  const error = await rejection(engine.load('whisper', directory))
  expect(error.code).toBe('protocol')
  expect(error.message).toContain('protocol 2')
})

it('rejects a worker without command or protocol channels', async () => {
  const worker = new FakeWorker()
  worker.stdin = null
  const { engine } = fixture({}, worker)
  const directory = await modelDirectory()
  const error = await rejection(engine.load('whisper', directory))
  expect(error.code).toBe('protocol')
  expect(worker.killSignals).toContain('SIGKILL')
})

it('rejects a worker that cannot be spawned', async () => {
  const engine = createAsrEngine({
    idleMs: 0,
    spawn: () => { throw new Error('EACCES') },
  })
  const directory = await modelDirectory()
  const error = await rejection(engine.load('whisper', directory))
  expect(error.code).toBe('crashed')
  expect(error.message).toContain('EACCES')
})

it('transcribes two jobs in order with one in-flight request', async () => {
  const worker = new FakeWorker()
  const observed: Extract<AsrWorkerCommand, { type: 'transcribe' }>[] = []
  worker.onCommand = (command, fake) => {
    if (command.type === 'load' || command.type === 'shutdown') fake.respond(command)
    else observed.push(command)
  }
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  const first = engine.transcribe(request('one'))
  const second = engine.transcribe(request('two'))
  await vi.waitFor(() => { expect(observed).toHaveLength(1) })
  expect(observed[0]?.id).toBe('one')
  worker.send({ type: 'result', id: 'one', text: 'first words', confidence: 0.75, durationMs: 12 })
  expect(await first).toEqual({ id: 'one', text: 'first words', confidence: 0.75, durationMs: 12, model: 'whisper' })
  await vi.waitFor(() => { expect(observed).toHaveLength(2) })
  expect(observed[1]?.id).toBe('two')
  worker.send({ type: 'result', id: 'two', text: 'second words', durationMs: 3 })
  expect((await second).text).toBe('second words')
})

it('omits confidence when the worker has none', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.respond(command)
      else if (command.type === 'transcribe') {
        fake.send({ type: 'result', id: command.id, text: 'silence', durationMs: 1 })
      }
    },
  })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  const result = await engine.transcribe(request('quiet'))
  expect(result).toEqual({ id: 'quiet', text: 'silence', durationMs: 1, model: 'whisper' })
  expect('confidence' in result).toBe(false)
})

it('bounds the waiting queue and rejects rather than growing it', async () => {
  const worker = new FakeWorker()
  const observed: Extract<AsrWorkerCommand, { type: 'transcribe' }>[] = []
  worker.onCommand = (command, fake) => {
    if (command.type === 'load') fake.respond(command)
    else if (command.type === 'transcribe') observed.push(command)
  }
  const { engine } = fixture({ maxQueue: 1 }, worker)
  await engine.load('whisper', await modelDirectory())
  const first = engine.transcribe(request('one'))
  const second = engine.transcribe(request('two'))
  await vi.waitFor(() => { expect(observed).toHaveLength(1) })
  expect((await rejection(engine.transcribe(request('three')))).code).toBe('queue-full')
  for (const command of observed) worker.send({ type: 'result', id: command.id, text: command.id, durationMs: 1 })
  expect((await first).text).toBe('one')
  await vi.waitFor(() => { expect(observed).toHaveLength(2) })
  worker.send({ type: 'result', id: 'two', text: 'two', durationMs: 1 })
  expect((await second).text).toBe('two')
})

it('stops the child after the idle budget and respawns for the next request', async () => {
  const worker = new FakeWorker()
  const { engine, spawner } = fixture({ idleMs: 20 }, worker)
  await engine.load('whisper', await modelDirectory())
  await engine.transcribe(request('one'))
  await vi.waitFor(() => {
    expect(worker.commands.map(command => command.type)).toEqual(['load', 'transcribe', 'shutdown'])
  })
  expect(engine.status).toBe('ready')
  expect(engine.model).toBe('whisper')
  expect(spawner.calls).toHaveLength(1)
  const result = await engine.transcribe(request('two'))
  expect(result.text).toBe('heard two')
  expect(spawner.calls).toHaveLength(2)
})

it('keeps the child warm when the idle budget is zero', async () => {
  const worker = new FakeWorker()
  const { engine, spawner } = fixture({ idleMs: 0 }, worker)
  await engine.load('whisper', await modelDirectory())
  await engine.transcribe(request('one'))
  await engine.transcribe(request('two'))
  expect(spawner.calls).toHaveLength(1)
  expect(worker.commands.filter(command => command.type === 'shutdown')).toHaveLength(0)
})

it('rejects the in-flight job when the child dies and stays usable', async () => {
  const first = new FakeWorker({
    onCommand: (command) => {
      if (command.type === 'load') first.respond(command)
    },
  })
  const { engine, spawner } = fixture({}, first)
  await engine.load('whisper', await modelDirectory())
  const pending = engine.transcribe(request('fatal'))
  await vi.waitFor(() => { expect(transcribeCommands(first)).toHaveLength(1) })
  first.crash('native decoder aborted')
  const error = await rejection(pending)
  expect(error.code).toBe('crashed')
  expect(error.message).toContain('native decoder aborted')
  expect(engine.status).toBe('ready')
  expect(engine.model).toBe('whisper')
  const result = await engine.transcribe(request('recovered'))
  expect(result.text).toBe('heard recovered')
  expect(spawner.calls).toHaveLength(2)
})

it('runs a queued job on a fresh child after the first job crashes', async () => {
  const worker = new FakeWorker()
  const observed: Extract<AsrWorkerCommand, { type: 'transcribe' }>[] = []
  worker.onCommand = (command, fake) => {
    if (command.type === 'load') fake.respond(command)
    else if (command.type === 'transcribe') observed.push(command)
  }
  const { engine, spawner } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  const first = engine.transcribe(request('one'))
  const second = engine.transcribe(request('two'))
  await vi.waitFor(() => { expect(observed).toHaveLength(1) })
  worker.crash('segfault')
  expect((await rejection(first)).code).toBe('crashed')
  await vi.waitFor(() => { expect(spawner.calls).toHaveLength(2) })
  expect((await second).text).toBe('heard two')
})

it('respawns after a crash while the engine is idle', async () => {
  const worker = new FakeWorker()
  const { engine, spawner } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  worker.crash()
  await vi.waitFor(() => { expect(engine.status).toBe('ready') })
  const result = await engine.transcribe(request('after-idle-crash'))
  expect(result.text).toBe('heard after-idle-crash')
  expect(spawner.calls).toHaveLength(2)
})

it('fails the engine on a response frame that is not JSON', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.respond(command)
      else if (command.type === 'transcribe') fake.sendRaw('this is not json\n')
    },
  })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  const error = await rejection(engine.transcribe(request('garbage')))
  expect(error.code).toBe('protocol')
  expect(engine.status).toBe('error')
  expect((await rejection(engine.transcribe(request('again')))).code).toBe('state')
})

it('fails the engine on an unknown response id', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.respond(command)
      else if (command.type === 'transcribe') fake.send({ type: 'result', id: 'stranger', text: 'x', durationMs: 1 })
    },
  })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  const error = await rejection(engine.transcribe(request('one')))
  expect(error.code).toBe('protocol')
  expect(error.message).toContain('unknown request id')
})

it('fails the engine on a failure frame without an id', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.respond(command)
      else if (command.type === 'transcribe') fake.send({ type: 'error', code: 'internal', message: 'boom' })
    },
  })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  const error = await rejection(engine.transcribe(request('one')))
  expect(error.code).toBe('protocol')
  expect(error.message).toContain('without a request id')
})

it('fails the engine on a response frame with an unexpected shape', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.respond(command)
      else if (command.type === 'transcribe') fake.sendRaw(`${JSON.stringify({ type: 'result', id: command.id, text: 42 })}\n`)
    },
  })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  expect((await rejection(engine.transcribe(request('one')))).message).toContain('invalid response frame')
})

it('fails the engine when a response frame exceeds its byte limit', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.respond(command)
      else if (command.type === 'transcribe') fake.sendRaw('x'.repeat(8 * 1024 * 1024 + 1))
    },
  })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  expect((await rejection(engine.transcribe(request('huge')))).message).toContain('byte limit')
})

it('fails the engine on a repeated readiness frame', async () => {
  const worker = new FakeWorker()
  worker.onCommand = () => { /* leave the load unanswered so the duplicate readiness frame is the only reply */ }
  const { engine } = fixture({}, worker)
  const loading = engine.load('whisper', await modelDirectory())
  await vi.waitFor(() => { expect(worker.commands).toHaveLength(1) })
  worker.send({ type: 'hello', protocol: 1 })
  const error = await rejection(loading)
  expect(error.code).toBe('protocol')
  expect(error.message).toContain('repeated its readiness frame')
})

it('times out a job, kills the child, and accepts the next job', async () => {
  const worker = new FakeWorker()
  worker.onCommand = (command, fake) => {
    if (command.type === 'load') fake.respond(command)
  }
  const { engine, spawner } = fixture({ jobTimeoutMs: 10 }, worker)
  await engine.load('whisper', await modelDirectory())
  const pending = engine.transcribe(request('stuck'))
  const error = await rejection(pending)
  expect(error.code).toBe('timeout')
  expect(error.message).toContain('transcribe request stuck')
  expect(worker.killSignals).toContain('SIGKILL')
  expect(engine.status).toBe('ready')
  const result = await engine.transcribe(request('next'))
  expect(result.text).toBe('heard next')
  expect(spawner.calls).toHaveLength(2)
})

it('rejects a queued transcription when the worker answers without a result', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.respond(command)
      else if (command.type === 'transcribe') fake.send({ type: 'loaded', id: command.id, model: 'whisper' })
    },
  })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  const error = await rejection(engine.transcribe(request('odd')))
  expect(error.code).toBe('protocol')
  expect(error.message).toContain('without a result')
})

it('reports a command channel that fails while writing', async () => {
  const worker = new FakeWorker()
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  vi.spyOn(worker.stdin!, 'write').mockImplementation(() => { throw new Error('EPIPE') })
  const error = await rejection(engine.transcribe(request('broken-pipe')))
  expect(error.code).toBe('crashed')
  expect(error.message).toContain('EPIPE')
})

it('stops a child that ignores the shutdown command', async () => {
  const worker = new FakeWorker()
  worker.autoExitOnShutdown = false
  const { engine } = fixture({ shutdownGraceMs: 10 }, worker)
  await engine.load('whisper', await modelDirectory())
  vi.spyOn(worker.stdin!, 'write').mockImplementation(() => { throw new Error('EPIPE') })
  await engine.unload()
  expect(worker.killSignals).toContain('SIGKILL')
  expect(engine.status).toBe('unloaded')
})

it('surfaces a child that fails before readiness', async () => {
  const worker = new FakeWorker({ hello: false })
  const { engine, spawner } = fixture({ readinessTimeoutMs: 5000 }, worker)
  const loading = engine.load('whisper', await modelDirectory())
  await vi.waitFor(() => { expect(spawner.calls).toHaveLength(1) })
  worker.fail(new Error('spawn ENOENT'))
  const error = await rejection(loading)
  expect(error.code).toBe('crashed')
  expect(error.message).toContain('failed to start')
})

it('works without a stderr channel', async () => {
  const worker = new FakeWorker({ stderr: false })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  expect((await engine.transcribe(request('one'))).text).toBe('heard one')
})

it('unloads the model, stops the child, and refuses further work', async () => {
  const worker = new FakeWorker()
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  await engine.unload()
  expect(worker.commands.map(command => command.type)).toEqual(['load', 'shutdown'])
  expect(engine.status).toBe('unloaded')
  expect(engine.model).toBeNull()
  await engine.unload()
  expect((await rejection(engine.transcribe(request('late')))).code).toBe('state')
})

it('rejects queued and in-flight work when unloading', async () => {
  const worker = new FakeWorker()
  const observed: Extract<AsrWorkerCommand, { type: 'transcribe' }>[] = []
  worker.onCommand = (command, fake) => {
    if (command.type === 'load') fake.respond(command)
    else if (command.type === 'transcribe') observed.push(command)
    else if (command.type === 'shutdown') fake.respond(command)
  }
  const { engine } = fixture({ maxQueue: 2 }, worker)
  await engine.load('whisper', await modelDirectory())
  const first = engine.transcribe(request('one'))
  const second = engine.transcribe(request('two'))
  await vi.waitFor(() => { expect(observed).toHaveLength(1) })
  const unloading = engine.unload()
  const errors = await Promise.all([rejection(first), rejection(second)])
  expect(errors.map(error => error.code)).toEqual(['state', 'state'])
  expect(errors.map(error => error.message)).toEqual(['ASR engine unloaded', 'ASR engine is unloading'])
  await unloading
  expect(worker.killSignals).toEqual([])
})

it('coalesces a second unload while the first is stopping the child', async () => {
  const worker = new FakeWorker()
  worker.autoExitOnShutdown = false
  const { engine } = fixture({ shutdownGraceMs: 20 }, worker)
  await engine.load('whisper', await modelDirectory())
  const first = engine.unload()
  await engine.unload()
  await first
  expect(worker.killSignals).toContain('SIGKILL')
})

it('refuses to change models while a transcription is active', async () => {
  const worker = new FakeWorker()
  worker.onCommand = (command, fake) => {
    if (command.type === 'load') fake.respond(command)
  }
  const { engine } = fixture({}, worker)
  const directory = await modelDirectory()
  await engine.load('whisper', directory)
  const pending = engine.transcribe(request('active'))
  await vi.waitFor(() => { expect(transcribeCommands(worker)).toHaveLength(1) })
  expect((await rejection(engine.load('parakeet', directory))).code).toBe('state')
  worker.send({ type: 'result', id: 'active', text: 'done', durationMs: 1 })
  await pending
})

it('refuses a second load while the first is still loading', async () => {
  const worker = new FakeWorker()
  worker.onCommand = () => { /* answer the held load after the second attempt is refused */ }
  const { engine } = fixture({}, worker)
  const directory = await modelDirectory()
  const loading = engine.load('whisper', directory)
  await vi.waitFor(() => { expect(worker.commands).toHaveLength(1) })
  expect((await rejection(engine.load('parakeet', directory))).code).toBe('state')
  worker.respond(worker.commands[0]!)
  await loading
})

it('refuses to unload while a model is loading', async () => {
  const worker = new FakeWorker()
  worker.onCommand = () => { /* hold the load until the unload attempt is refused */ }
  const { engine } = fixture({}, worker)
  const directory = await modelDirectory()
  const loading = engine.load('whisper', directory)
  await vi.waitFor(() => { expect(worker.commands).toHaveLength(1) })
  expect((await rejection(engine.unload())).code).toBe('state')
  worker.respond(worker.commands[0]!)
  await loading
  expect(engine.status).toBe('ready')
})


it('defaults every option when constructed without arguments', async () => {
  const engine = createAsrEngine()
  expect(engine.status).toBe('unloaded')
  expect(engine.model).toBeNull()
  expect((await rejection(engine.transcribe(request('none')))).code).toBe('state')
})

it('refuses load and transcription while unloading', async () => {
  const worker = new FakeWorker()
  worker.autoExitOnShutdown = false
  const { engine } = fixture({ shutdownGraceMs: 20 }, worker)
  const directory = await modelDirectory()
  await engine.load('whisper', directory)
  const unloading = engine.unload()
  expect((await rejection(engine.load('parakeet', directory))).message).toContain('unloading')
  expect((await rejection(engine.transcribe(request('late')))).message).toContain('unloading')
  await unloading
})

it('stops the previous child when a switch target is invalid', async () => {
  const worker = new FakeWorker()
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  const error = await rejection(engine.load('parakeet', join(tmpdir(), 'dsh-asr-absent-switch')))
  expect(error.code).toBe('model-not-found')
  expect(worker.commands.map(command => command.type)).toEqual(['load', 'shutdown'])
  expect(engine.status).toBe('error')
  expect(engine.model).toBeNull()
})

it('joins an idle stop before serving the next request', async () => {
  const first = new FakeWorker()
  first.autoExitOnShutdown = false
  const second = new FakeWorker()
  const { engine, spawner } = fixture({ idleMs: 15, shutdownGraceMs: 60 }, first, second)
  await engine.load('whisper', await modelDirectory())
  await engine.transcribe(request('one'))
  await vi.waitFor(() => { expect(first.commands.some(command => command.type === 'shutdown')).toBe(true) })
  expect((await engine.transcribe(request('two'))).text).toBe('heard two')
  expect(spawner.calls).toHaveLength(2)
})

it('unloads while an idle stop is still waiting for its child', async () => {
  const worker = new FakeWorker()
  worker.autoExitOnShutdown = false
  const { engine } = fixture({ idleMs: 15, shutdownGraceMs: 60 }, worker)
  await engine.load('whisper', await modelDirectory())
  await engine.transcribe(request('one'))
  await vi.waitFor(() => { expect(worker.commands.some(command => command.type === 'shutdown')).toBe(true) })
  await engine.unload()
  expect(engine.status).toBe('unloaded')
  expect(worker.killSignals).toContain('SIGKILL')
})

it('forwards an explicit language hint to the worker', async () => {
  const worker = new FakeWorker()
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  await engine.transcribe({ ...request('de'), language: 'de' })
  expect(transcribeCommands(worker)[0]).toMatchObject({ language: 'de' })
})

it('rejects a load acknowledgement that is not a loaded frame', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.send({ type: 'closed', id: command.id })
      else if (command.type === 'shutdown') fake.respond(command)
    },
  })
  const { engine } = fixture({}, worker)
  const error = await rejection(engine.load('whisper', await modelDirectory()))
  expect(error.code).toBe('protocol')
  expect(error.message).toContain('unexpected command')
})

it('marks the engine failed when a respawn cannot load its model', async () => {
  const first = new FakeWorker({
    onCommand: (command, fake) => { if (command.type === 'load') fake.respond(command) },
  })
  const second = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') {
        fake.send({ type: 'error', id: command.id, code: 'model-not-found', message: 'model vanished' })
      } else if (command.type === 'shutdown') {
        fake.respond(command)
      }
    },
  })
  const { engine } = fixture({}, first, second)
  await engine.load('whisper', await modelDirectory())
  first.crash()
  const error = await rejection(engine.transcribe(request('after-crash')))
  expect(error.code).toBe('model-not-found')
  expect(engine.status).toBe('error')
})

it('keeps serving after protocol and command pipe errors', async () => {
  const worker = new FakeWorker()
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  worker.emitProtocolError(new Error('protocol pipe failed'))
  worker.emitStdinError(new Error('command pipe failed'))
  expect((await engine.transcribe(request('still'))).text).toBe('heard still')
})

it('ignores blank protocol lines', async () => {
  const worker = new FakeWorker({
    onCommand: (command, fake) => {
      if (command.type === 'load') fake.respond(command)
      else if (command.type === 'transcribe') {
        fake.sendRaw('\n')
        fake.send({ type: 'result', id: command.id, text: 'after blank', durationMs: 1 })
      }
    },
  })
  const { engine } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  expect((await engine.transcribe(request('blank'))).text).toBe('after blank')
})

it('drops an idle stop when the child is already gone', async () => {
  const worker = new FakeWorker()
  const { engine } = fixture({ idleMs: 20 }, worker)
  await engine.load('whisper', await modelDirectory())
  await engine.transcribe(request('one'))
  worker.crash()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(engine.status).toBe('ready')
  await engine.unload()
})

it('defers the idle stop when a new request arrives first', async () => {
  const worker = new FakeWorker()
  const { engine, spawner } = fixture({ idleMs: 40 }, worker)
  await engine.load('whisper', await modelDirectory())
  await engine.transcribe(request('one'))
  expect((await engine.transcribe(request('two'))).text).toBe('heard two')
  expect(spawner.calls).toHaveLength(1)
  await engine.unload()
})

it('respawns after a child exits with an unknown code', async () => {
  const worker = new FakeWorker()
  const { engine, spawner } = fixture({}, worker)
  await engine.load('whisper', await modelDirectory())
  worker.exit(null)
  expect((await engine.transcribe(request('after-unknown-exit'))).text).toBe('heard after-unknown-exit')
  expect(spawner.calls).toHaveLength(2)
})

it('describes a non-Error spawn failure', async () => {
  const engine = createAsrEngine({
    idleMs: 0,
    spawn: () => { throw 'permission denied' },
  })
  const error = await rejection(engine.load('whisper', await modelDirectory()))
  expect(error.code).toBe('crashed')
  expect(error.message).toContain('permission denied')
})
