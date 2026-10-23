/**
 * ASR worker protocol and sherpa-onnx adapter. Injected backends and a fake
 * native module keep every path testable without downloading a model or
 * starting a child process.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import {
  AsrWorkerFailure,
  createSherpaBackendLoader,
  isWorkerInvocation,
  loadSherpaModule,
  main,
  runAsrWorker,
  type SherpaModule,
  type SherpaRecognizer,
  type SherpaStream,
} from '../src/engine/asr-worker.ts'
import type {
  AsrBackend,
  AsrBackendInput,
  AsrBackendLoader,
  AsrBackendResult,
  AsrWorkerResponse,
} from '../src/engine/types.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

class RecordingBackend implements AsrBackend {
  readonly inputs: AsrBackendInput[] = []
  closes = 0

  constructor(private readonly result: AsrBackendResult = { text: 'hello' }, private readonly failure?: Error,
    private readonly closeFailure?: Error) {}

  async transcribe(input: AsrBackendInput): Promise<AsrBackendResult> {
    this.inputs.push(input)
    if (this.failure !== undefined) throw this.failure
    return this.result
  }

  async close(): Promise<void> {
    this.closes += 1
    if (this.closeFailure !== undefined) throw this.closeFailure
  }
}

function loaderFor(...backends: RecordingBackend[]): { loader: AsrBackendLoader; loaded: string[] } {
  const loaded: string[] = []
  const pending = [...backends]
  return {
    loaded,
    loader: async (model, directory) => {
      loaded.push(`${model}:${directory}`)
      const backend = pending.shift()
      if (backend === undefined) throw new Error('no backend prepared')
      return backend
    },
  }
}

interface Harness {
  readonly frames: AsrWorkerResponse[]
  readonly commands: PassThrough
  readonly run: Promise<void>
}

function harness(loader: AsrBackendLoader): Harness {
  const frames: AsrWorkerResponse[] = []
  const commands = new PassThrough()
  const run = runAsrWorker({ commands, write: (frame) => { frames.push(frame) }, loadBackend: loader })
  return { frames, commands, run }
}

function write(commands: PassThrough, ...frames: object[]): void {
  for (const frame of frames) commands.write(`${JSON.stringify(frame)}\n`)
}

function pcmBase64(samples: readonly number[]): string {
  const pcm = Int16Array.from(samples)
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

async function finish(harnessed: Harness): Promise<void> {
  harnessed.commands.end()
  await harnessed.run
}

function failureOf(error: unknown): AsrWorkerFailure {
  if (!(error instanceof AsrWorkerFailure)) throw new Error('expected an AsrWorkerFailure')
  return error
}

async function modelFiles(files: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-asr-sherpa-'))
  directories.push(directory)
  for (const file of files) await writeFile(join(directory, file), 'x')
  return directory
}

interface FakeRecognizerState {
  config: Record<string, unknown>
  readonly configs: object[]
  readonly streams: FakeStream[]
}

interface FakeStream extends SherpaStream {
  readonly waveforms: Array<{ samples: Float32Array; sampleRate: number }>
}

interface FakeSherpaOptions {
  readonly text?: string
  readonly logProbabilities?: readonly number[]
  readonly fail?: Error
  readonly supportsSetConfig?: boolean
}

function fakeSherpa(options: FakeSherpaOptions = {}): {
  module: SherpaModule
  created: FakeRecognizerState[]
} {
  const created: FakeRecognizerState[] = []
  class Recognizer implements SherpaRecognizer {
    setConfig: ((config: object) => void) | undefined
    readonly state: FakeRecognizerState = { config: {}, configs: [], streams: [] }

    constructor(config: object) {
      this.state.config = config as Record<string, unknown>
      created.push(this.state)
      if (options.fail !== undefined) throw options.fail
      if (options.supportsSetConfig !== false) {
        this.setConfig = (replacement: object) => { this.state.configs.push(replacement) }
      }
    }

    createStream(): SherpaStream {
      const stream: FakeStream = {
        waveforms: [],
        acceptWaveform: (waveform) => { stream.waveforms.push(waveform) },
      }
      this.state.streams.push(stream)
      return stream
    }

    decode(): void {
      // The fake decodes nothing; the result is fixed per module.
    }

    getResult(): { text: string; ys_log_probs?: readonly number[] } {
      return {
        text: options.text ?? 'hello',
        ...options.logProbabilities === undefined ? {} : { ys_log_probs: options.logProbabilities },
      }
    }
  }
  return { module: { OfflineRecognizer: Recognizer }, created }
}

it('announces readiness, loads a model, transcribes, and stops on shutdown', async () => {
  const backend = new RecordingBackend({ text: 'hello world', confidence: 0.5 })
  const { loader } = loaderFor(backend)
  const harnessed = harness(loader)
  write(harnessed.commands,
    { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/models/whisper' },
    { type: 'transcribe', id: 'req-1', sampleRate: 16000, language: 'en', pcm: pcmBase64([1, -2, 3]) },
    { type: 'shutdown', id: 'stop-1' })
  await finish(harnessed)
  expect(harnessed.frames.map(frame => frame.type)).toEqual(['hello', 'loaded', 'result', 'closed'])
  expect(harnessed.frames[0]).toEqual({ type: 'hello', protocol: 1 })
  expect(harnessed.frames[1]).toEqual({ type: 'loaded', id: 'load-1', model: 'whisper' })
  expect(harnessed.frames[2]).toMatchObject({ type: 'result', id: 'req-1', text: 'hello world', confidence: 0.5 })
  expect(harnessed.frames[3]).toEqual({ type: 'closed', id: 'stop-1' })
  expect(backend.inputs).toHaveLength(1)
  expect(Array.from(backend.inputs[0]!.pcm)).toEqual([1, -2, 3])
  expect(backend.inputs[0]!.sampleRate).toBe(16000)
  expect(backend.inputs[0]!.language).toBe('en')
  expect(backend.closes).toBe(1)
})

it('closes the previous backend before loading the next model', async () => {
  const order: string[] = []
  const first = new RecordingBackend()
  const second = new RecordingBackend()
  const loader: AsrBackendLoader = async (model) => {
    order.push(`load:${model}`)
    return model === 'whisper' ? first : second
  }
  const originalClose = first.close.bind(first)
  first.close = async () => {
    order.push('close:whisper')
    await originalClose()
  }
  const harnessed = harness(loader)
  write(harnessed.commands,
    { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/a' },
    { type: 'load', id: 'load-2', model: 'parakeet', modelDirectory: '/b' })
  await finish(harnessed)
  expect(order).toEqual(['load:whisper', 'close:whisper', 'load:parakeet'])
  expect(harnessed.frames.filter(frame => frame.type === 'loaded')).toHaveLength(2)
})

it('reports a typed load failure and keeps the worker alive', async () => {
  const loader: AsrBackendLoader = async () => {
    throw new AsrWorkerFailure('model-incompatible', 'weights are corrupt')
  }
  const harnessed = harness(loader)
  write(harnessed.commands,
    { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/models' },
    { type: 'load', id: 'load-2', model: 'whisper', modelDirectory: '/models' })
  await finish(harnessed)
  expect(harnessed.frames[1]).toEqual({
    type: 'error',
    id: 'load-1',
    code: 'model-incompatible',
    message: 'weights are corrupt',
  })
  expect(harnessed.frames[2]).toMatchObject({ type: 'error', id: 'load-2', code: 'model-incompatible' })
})

it('reports a generic load failure as an internal error', async () => {
  const loader: AsrBackendLoader = async () => { throw new Error('native crash') }
  const harnessed = harness(loader)
  write(harnessed.commands, { type: 'load', id: 'load-1', model: 'parakeet', modelDirectory: '/models' })
  await finish(harnessed)
  expect(harnessed.frames[1]).toEqual({
    type: 'error',
    id: 'load-1',
    code: 'internal',
    message: 'native crash',
  })
})

it('reports a failure while closing the replaced backend', async () => {
  const first = new RecordingBackend(undefined, undefined, new Error('close failed'))
  const second = new RecordingBackend()
  const { loader } = loaderFor(first, second)
  const harnessed = harness(loader)
  write(harnessed.commands,
    { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/a' },
    { type: 'load', id: 'load-2', model: 'parakeet', modelDirectory: '/b' })
  await finish(harnessed)
  expect(harnessed.frames[2]).toMatchObject({ type: 'error', id: 'load-2', code: 'internal', message: 'close failed' })
})

it('rejects transcription before a model is loaded', async () => {
  const { loader } = loaderFor()
  const harnessed = harness(loader)
  write(harnessed.commands, { type: 'transcribe', id: 'req-1', sampleRate: 16000, pcm: pcmBase64([1]) })
  await finish(harnessed)
  expect(harnessed.frames[1]).toEqual({
    type: 'error',
    id: 'req-1',
    code: 'internal',
    message: 'ASR worker has no loaded model',
  })
})

it('rejects a payload that is not a whole number of 16-bit samples', async () => {
  const backend = new RecordingBackend()
  const { loader } = loaderFor(backend)
  const harnessed = harness(loader)
  write(harnessed.commands,
    { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/models' },
    { type: 'transcribe', id: 'odd', sampleRate: 16000, pcm: Buffer.from([1, 2, 3]).toString('base64') })
  await finish(harnessed)
  expect(harnessed.frames[2]).toMatchObject({ type: 'error', id: 'odd', code: 'invalid-input' })
  expect(backend.inputs).toHaveLength(0)
})

it('rejects a sample rate other than 16 kHz as a protocol violation', async () => {
  const backend = new RecordingBackend()
  const { loader } = loaderFor(backend)
  const harnessed = harness(loader)
  write(harnessed.commands,
    { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/models' },
    { type: 'transcribe', id: 'wrong-rate', sampleRate: 8000, pcm: pcmBase64([1]) })
  await finish(harnessed)
  expect(harnessed.frames[2]).toMatchObject({ type: 'error', code: 'protocol' })
})

it('maps backend transcription failures to their codes', async () => {
  const invalid = new RecordingBackend(undefined, new AsrWorkerFailure('invalid-input', 'audio is silent'))
  const internal = new RecordingBackend(undefined, new Error('decoder exploded'))
  const { loader } = loaderFor(invalid, internal)
  const harnessed = harness(loader)
  write(harnessed.commands,
    { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/a' },
    { type: 'transcribe', id: 'req-1', sampleRate: 16000, pcm: pcmBase64([1]) },
    { type: 'load', id: 'load-2', model: 'whisper', modelDirectory: '/b' },
    { type: 'transcribe', id: 'req-2', sampleRate: 16000, pcm: pcmBase64([1]) })
  await finish(harnessed)
  expect(harnessed.frames[2]).toMatchObject({ type: 'error', id: 'req-1', code: 'invalid-input' })
  expect(harnessed.frames[4]).toMatchObject({ type: 'error', id: 'req-2', code: 'internal' })
})

it('ignores blank lines and continues after a malformed frame', async () => {
  const backend = new RecordingBackend()
  const { loader } = loaderFor(backend)
  const harnessed = harness(loader)
  harnessed.commands.write('\nnot json\n')
  harnessed.commands.write(`${JSON.stringify({ type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/m' })}\n`)
  await finish(harnessed)
  expect(harnessed.frames.map(frame => frame.type)).toEqual(['hello', 'error', 'loaded'])
  expect(harnessed.frames[1]).toMatchObject({ type: 'error', code: 'protocol' })
})

it('rejects an unknown command type as a protocol violation', async () => {
  const { loader } = loaderFor()
  const harnessed = harness(loader)
  write(harnessed.commands, { type: 'rewind' })
  await finish(harnessed)
  expect(harnessed.frames[1]).toMatchObject({ type: 'error', code: 'protocol' })
})

it('processes a command frame split across chunks', async () => {
  const backend = new RecordingBackend()
  const { loader } = loaderFor(backend)
  const harnessed = harness(loader)
  harnessed.commands.write('{"type":"load","id":"load-1","model":"whi')
  harnessed.commands.write('sper","modelDirectory":"/models"}\n')
  await finish(harnessed)
  expect(harnessed.frames[1]).toEqual({ type: 'loaded', id: 'load-1', model: 'whisper' })
})

it('reports a trailing frame that end-of-stream truncates', async () => {
  const { loader } = loaderFor()
  const harnessed = harness(loader)
  harnessed.commands.write('{"type":"load","id":"load-1"')
  await finish(harnessed)
  expect(harnessed.frames[1]).toMatchObject({ type: 'error', code: 'protocol' })
  expect(harnessed.frames[1]).toHaveProperty('message', 'ASR worker command frame was not terminated')
})

it('stops on an oversized terminated frame', async () => {
  const { loader } = loaderFor()
  const harnessed = harness(loader)
  write(harnessed.commands, { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/models' })
  harnessed.commands.write(`${'x'.repeat(8 * 1024 * 1024 + 1)}\n`)
  await finish(harnessed)
  expect(harnessed.frames.at(-1)).toMatchObject({ type: 'error', code: 'protocol' })
  expect(harnessed.frames.at(-1)).toHaveProperty('message', 'ASR worker command frame exceeded its byte limit')
})

it('stops on an oversized unterminated frame', async () => {
  const { loader } = loaderFor()
  const harnessed = harness(loader)
  harnessed.commands.write('x'.repeat(8 * 1024 * 1024 + 1))
  await finish(harnessed)
  expect(harnessed.frames[1]).toMatchObject({ type: 'error', code: 'protocol' })
})

it('closes the loaded backend when the command stream ends', async () => {
  const backend = new RecordingBackend()
  const { loader } = loaderFor(backend)
  const harnessed = harness(loader)
  write(harnessed.commands, { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/models' })
  await finish(harnessed)
  expect(backend.closes).toBe(1)
})

it('binds main to a supplied command stream and frame sink', async () => {
  const frames: AsrWorkerResponse[] = []
  const backend = new RecordingBackend({ text: 'through main' })
  const { loader } = loaderFor(backend)
  await main(Readable.from([
    `${JSON.stringify({ type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/m' })}\n`,
    `${JSON.stringify({ type: 'transcribe', id: 'req-1', sampleRate: 16000, pcm: pcmBase64([5]) })}\n`,
  ]), (frame) => { frames.push(frame) }, loader)
  expect(frames.map(frame => frame.type)).toEqual(['hello', 'loaded', 'result'])
  expect(frames[2]).toMatchObject({ text: 'through main' })
})

it('recognizes the worker entry from the process arguments', () => {
  const moduleUrl = new URL('../src/engine/asr-worker.ts', import.meta.url).href
  expect(isWorkerInvocation(['/node', fileURLToPath(moduleUrl)], moduleUrl)).toBe(true)
  expect(isWorkerInvocation(['/node'], moduleUrl)).toBe(false)
  expect(isWorkerInvocation(['/node', '/somewhere/else.mjs'], moduleUrl)).toBe(false)
  expect(isWorkerInvocation(['/node', '/does/not/exist.mjs'], moduleUrl)).toBe(false)
})

it('loads a whisper model, converts PCM, trims text, and applies a language hint', async () => {
  const { module, created } = fakeSherpa({
    text: '  hello world  ',
    logProbabilities: [Math.log(0.5), Math.log(0.5)],
  })
  const loader = createSherpaBackendLoader(() => module)
  const directory = await modelFiles(['encoder.int8.onnx', 'decoder.onnx', 'tokens.txt'])
  const backend = await loader('whisper', directory)
  const result = await backend.transcribe({ pcm: Int16Array.from([1, -2]), sampleRate: 16000, language: 'de' })
  expect(result.text).toBe('hello world')
  expect(result.confidence).toBeCloseTo(0.5)
  expect(created[0]?.config).toMatchObject({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: join(directory, 'encoder.int8.onnx'),
        decoder: join(directory, 'decoder.onnx'),
        language: 'de',
        task: 'transcribe',
        tailPaddings: -1,
      },
      tokens: join(directory, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  })
  expect(created[0]?.configs).toHaveLength(1)
  expect(created[0]?.streams).toHaveLength(1)
  const waveform = created[0]?.streams[0]?.waveforms[0]
  expect(waveform?.sampleRate).toBe(16000)
  expect(Array.from(waveform?.samples ?? [])).toEqual([1 / 32768, -2 / 32768])
  await backend.close()
})

it('leaves the whisper language untouched without a request hint', async () => {
  const { module, created } = fakeSherpa({ text: 'plain' })
  const loader = createSherpaBackendLoader(() => module)
  const backend = await loader('whisper', await modelFiles(['encoder.onnx', 'decoder.onnx', 'tokens.txt']))
  expect((await backend.transcribe({ pcm: Int16Array.from([1]), sampleRate: 16000 })).confidence).toBeUndefined()
  expect(created[0]?.configs).toHaveLength(0)
  expect(created[0]?.config).toMatchObject({ modelConfig: { whisper: { language: 'auto' } } })
})

it('tolerates a recognizer that cannot reconfigure its language', async () => {
  const { module, created } = fakeSherpa({ text: 'fixed', supportsSetConfig: false })
  const loader = createSherpaBackendLoader(() => module)
  const backend = await loader('whisper', await modelFiles(['encoder.onnx', 'decoder.onnx', 'tokens.txt']))
  expect((await backend.transcribe({ pcm: Int16Array.from([1]), sampleRate: 16000, language: 'en' })).text).toBe('fixed')
  expect(created[0]?.configs).toHaveLength(0)
})

it('loads a parakeet transducer and ignores language hints', async () => {
  const { module, created } = fakeSherpa({ text: 'parakeet text', logProbabilities: [] })
  const loader = createSherpaBackendLoader(() => module)
  const directory = await modelFiles(['encoder.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'])
  const backend = await loader('parakeet', directory)
  const result = await backend.transcribe({ pcm: Int16Array.from([7]), sampleRate: 16000, language: 'en' })
  expect(result).toEqual({ text: 'parakeet text' })
  expect(created[0]?.configs).toHaveLength(0)
  expect(created[0]?.config).toMatchObject({
    modelConfig: {
      transducer: {
        encoder: join(directory, 'encoder.onnx'),
        decoder: join(directory, 'decoder.onnx'),
        joiner: join(directory, 'joiner.int8.onnx'),
      },
      modelType: 'nemo_transducer',
    },
  })
})

it('rejects a model directory that does not exist', async () => {
  const loader = createSherpaBackendLoader(() => fakeSherpa().module)
  const error = await loader('whisper', join(tmpdir(), 'dsh-asr-sherpa-absent')).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AsrWorkerFailure)
  expect(error).toMatchObject({ code: 'model-not-found' })
})

it('rejects a model directory that cannot be read', async () => {
  const loader = createSherpaBackendLoader(() => fakeSherpa().module)
  const error = failureOf(await loader('whisper', '\0invalid').catch((caught: unknown) => caught))
  expect(error.code).toBe('model-incompatible')
  expect(error.message).toContain('cannot be read')
})

it.each([
  ['tokens.txt', ['encoder.onnx', 'decoder.onnx']],
  ['encoder.onnx', ['decoder.onnx', 'tokens.txt']],
  ['decoder.onnx', ['encoder.onnx', 'tokens.txt']],
])('rejects a whisper directory missing %s', async (label, files) => {
  const loader = createSherpaBackendLoader(() => fakeSherpa().module)
  const error = failureOf(await loader('whisper', await modelFiles(files)).catch((caught: unknown) => caught))
  expect(error.code).toBe('model-incompatible')
  expect(error.message).toContain(label)
})

it('rejects a model file the native loader would abort on', async () => {
  const loader = createSherpaBackendLoader(() => fakeSherpa().module)
  const directory = await modelFiles(['decoder.onnx', 'tokens.txt'])
  await writeFile(join(directory, 'encoder.onnx'), '')
  const error = failureOf(await loader('whisper', directory).catch((caught: unknown) => caught))
  expect(error.code).toBe('model-incompatible')
  expect(error.message).toContain('is empty')
})

it('rejects a parakeet directory without a joiner', async () => {
  const loader = createSherpaBackendLoader(() => fakeSherpa().module)
  const directory = await modelFiles(['encoder.onnx', 'decoder.onnx', 'tokens.txt'])
  const error = failureOf(await loader('parakeet', directory).catch((caught: unknown) => caught))
  expect(error.code).toBe('model-incompatible')
  expect(error.message).toContain('joiner.onnx')
})

it('reports a recognizer that the native binding rejects', async () => {
  const loader = createSherpaBackendLoader(() => fakeSherpa({ fail: new Error('onnx load failed') }).module)
  const error = failureOf(await loader('whisper', await modelFiles(['encoder.onnx', 'decoder.onnx', 'tokens.txt']))
    .catch((caught: unknown) => caught))
  expect(error.code).toBe('model-incompatible')
  expect(error.message).toContain('onnx load failed')
})

it.each([
  [[Math.log(0.25)], 0.25],
  [[10, 10], 1],
  [[-100, -100], 0],
])('derives confidence from token log probabilities %j', async (logProbabilities, expected) => {
  const { module } = fakeSherpa({ logProbabilities, text: 'x' })
  const loader = createSherpaBackendLoader(() => module)
  const backend = await loader('whisper', await modelFiles(['encoder.onnx', 'decoder.onnx', 'tokens.txt']))
  const result = await backend.transcribe({ pcm: Int16Array.from([1]), sampleRate: 16000 })
  expect(result.confidence).toBeCloseTo(expected)
})

it('omits confidence for missing, empty, or non-finite scores', async () => {
  for (const logProbabilities of [undefined, [], [Number.POSITIVE_INFINITY]]) {
    const options = logProbabilities === undefined ? { text: 'x' } : { text: 'x', logProbabilities }
    const { module } = fakeSherpa(options)
    const loader = createSherpaBackendLoader(() => module)
    const backend = await loader('whisper', await modelFiles(['encoder.onnx', 'decoder.onnx', 'tokens.txt']))
    expect((await backend.transcribe({ pcm: Int16Array.from([1]), sampleRate: 16000 })).confidence).toBeUndefined()
  }
})

it('loads the installed sherpa-onnx binding when the platform binary is present', () => {
  let module: SherpaModule
  try {
    module = loadSherpaModule()
  } catch {
    // The optional platform binary is absent on this host; the adapter's injected-module tests still cover the contract.
    return
  }
  expect(typeof module.version).toBe('string')
})

it('describes a non-Error load failure', async () => {
  const loader: AsrBackendLoader = async () => { throw 'not an error' }
  const harnessed = harness(loader)
  write(harnessed.commands, { type: 'load', id: 'load-1', model: 'whisper', modelDirectory: '/models' })
  await finish(harnessed)
  expect(harnessed.frames[1]).toEqual({ type: 'error', id: 'load-1', code: 'internal', message: 'not an error' })
})
