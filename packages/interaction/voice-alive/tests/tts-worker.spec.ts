/** Worker protocol, WAV encoding, model discovery, and the spawned entry contract. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { onTestFinished, describe, expect, it } from 'vitest'
import {
  encodeWav,
  main,
  parseWorkerConfig,
  redirectConsole,
  resolveKokoroDtype,
  runWorker,
  type WorkerBackend,
} from '../src/engine/tts-worker.ts'

/** Create a temp directory removed after the test. */
async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tts-worker-'))
  onTestFinished(async () => {
    const fs = await import('node:fs/promises')
    await fs.rm(directory, { recursive: true, force: true })
  })
  return directory
}

/** A backend returning a deterministic short tone. */
function fakeBackend(overrides: Partial<WorkerBackend> = {}): WorkerBackend {
  return {
    sampleRate: 24_000,
    synthesize: async () => ({ samples: new Float32Array([0, 0.5, -0.5]), sampleRate: 24_000 }),
    ...overrides,
  }
}

/** Read one little-endian four-character identifier. */
function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

/** Collect newline-delimited JSON frames written to a stream. */
function frameReader(): { output: PassThrough; frames: Array<Record<string, unknown>> } {
  const output = new PassThrough()
  const frames: Array<Record<string, unknown>> = []
  createInterface({ input: output }).on('line', (line) => { frames.push(JSON.parse(line) as Record<string, unknown>) })
  return { output, frames }
}

/** Wait until the predicate holds. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000 && !predicate(); turn++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(predicate()).toBe(true)
}

describe('redirectConsole', () => {
  it('writes third-party console output to stderr', () => {
    const original = process.stderr.write.bind(process.stderr)
    const calls: string[] = []
    process.stderr.write = (chunk: string | Uint8Array) => {
      calls.push(String(chunk))
      return true
    }
    redirectConsole()
    console.log('noise', 1)
    console.warn('warning')
    process.stderr.write = original
    expect(calls).toContain('noise 1\n')
    expect(calls).toContain('warning\n')
  })
})

describe('parseWorkerConfig', () => {
  it('accepts a complete configuration', () => {
    expect(parseWorkerConfig(JSON.stringify({ modelDirectory: '/models/kokoro', voice: 'af_heart' }))).toEqual({
      modelDirectory: '/models/kokoro', voice: 'af_heart',
    })
  })

  it.each([
    ['a missing argument', undefined, 'configuration is missing'],
    ['malformed JSON', '{', 'JSON'],
    ['a non-object', '[]', 'must be an object'],
    ['a missing model directory', JSON.stringify({ voice: 'af_heart' }), 'modelDirectory'],
    ['an empty model directory', JSON.stringify({ modelDirectory: '', voice: 'af_heart' }), 'modelDirectory'],
    ['a missing voice', JSON.stringify({ modelDirectory: '/models' }), 'voice'],
    ['an empty voice', JSON.stringify({ modelDirectory: '/models', voice: '' }), 'voice'],
  ])('rejects %s', (_case, raw, message) => {
    expect(() => parseWorkerConfig(raw)).toThrow(message)
  })
})

describe('resolveKokoroDtype', () => {
  it('selects quantized weights when present', async () => {
    const directory = await tempDirectory()
    await mkdir(join(directory, 'onnx'))
    await writeFile(join(directory, 'onnx', 'model_quantized.onnx'), '')
    await expect(resolveKokoroDtype(directory)).resolves.toBe('q8')
  })

  it('falls back to full precision weights', async () => {
    const directory = await tempDirectory()
    await mkdir(join(directory, 'onnx'))
    await writeFile(join(directory, 'onnx', 'model.onnx'), '')
    await expect(resolveKokoroDtype(directory)).resolves.toBe('fp32')
  })

  it('prefers quantized weights when both files exist', async () => {
    const directory = await tempDirectory()
    await mkdir(join(directory, 'onnx'))
    await writeFile(join(directory, 'onnx', 'model_quantized.onnx'), '')
    await writeFile(join(directory, 'onnx', 'model.onnx'), '')
    await expect(resolveKokoroDtype(directory)).resolves.toBe('q8')
  })

  it('names the expected files when the model is absent', async () => {
    const directory = await tempDirectory()
    await expect(resolveKokoroDtype(directory)).rejects.toThrow(/model_quantized\.onnx.*model\.onnx/u)
  })

  it('surfaces filesystem errors other than absence', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'file')
    await writeFile(file, '')
    await expect(resolveKokoroDtype(file)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('encodeWav', () => {
  it('writes complete 24 kHz mono 16-bit PCM headers and clamped samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5, -0.5]))
    const view = new DataView(wav)
    expect(fourcc(view, 0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(44 + 7 * 2 - 8)
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
    expect(view.getUint32(40, true)).toBe(14)
    const samples = Array.from({ length: 7 }, (_, index) => view.getInt16(44 + index * 2, true))
    expect(samples).toEqual([0, 32_767, -32_768, 32_767, -32_768, 16_384, -16_384])
  })

  it('honours a different sample rate and an empty waveform', () => {
    const wav = encodeWav(new Float32Array(0), 16_000)
    const view = new DataView(wav)
    expect(wav.byteLength).toBe(44)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint32(40, true)).toBe(0)
  })
})

describe('runWorker', () => {
  it('answers every valid request with a chunk and ends at stdin close', async () => {
    const input = new PassThrough()
    const { output, frames } = frameReader()
    const running = runWorker(fakeBackend(), input, output)
    input.write(`${JSON.stringify({ type: 'synthesize', id: 'a', index: 0, text: 'Hello.', voice: 'af_heart' })}\n`)
    input.write('\n')
    input.write(`${JSON.stringify({ type: 'synthesize', id: 'a', index: 1, text: 'Again.', voice: 'af_heart' })}\n`)
    await waitFor(() => frames.length === 2)
    input.end()
    await running
    expect(frames.map(frame => frame.type)).toEqual(['chunk', 'chunk'])
    expect(frames.map(frame => frame.index)).toEqual([0, 1])
    expect(frames.map(frame => frame.durationMs)).toEqual([0, 0])
    const wav = Buffer.from(String(frames[0]?.wav), 'base64')
    expect(wav.byteLength).toBe(50)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('reports malformed request lines and keeps serving', async () => {
    const input = new PassThrough()
    const { output, frames } = frameReader()
    const running = runWorker(fakeBackend(), input, output)
    for (const line of [
      'not json',
      '[]',
      '42',
      JSON.stringify({ type: 'unknown' }),
      JSON.stringify({ type: 'synthesize', id: '', index: 0, text: 'x', voice: 'v' }),
      JSON.stringify({ type: 'synthesize', id: 'a', index: -1, text: 'x', voice: 'v' }),
      JSON.stringify({ type: 'synthesize', id: 'a', index: 0.5, text: 'x', voice: 'v' }),
      JSON.stringify({ type: 'synthesize', id: 'a', index: 0, text: '', voice: 'v' }),
      JSON.stringify({ type: 'synthesize', id: 'a', index: 0, text: 'x', voice: '' }),
    ]) input.write(`${line}\n`)
    input.write(`${JSON.stringify({ type: 'synthesize', id: 'ok', index: 0, text: 'Hello.', voice: 'af_heart' })}\n`)
    await waitFor(() => frames.some(frame => frame.type === 'chunk'))
    input.end()
    await running
    const errors = frames.filter(frame => frame.type === 'error')
    expect(errors).toHaveLength(9)
    for (const error of errors) expect(error.id).toBeUndefined()
  })

  it('reports backend failures with the request identity', async () => {
    const input = new PassThrough()
    const { output, frames } = frameReader()
    const running = runWorker(fakeBackend({
      synthesize: async () => { throw new Error('voice is unavailable') },
    }), input, output)
    input.write(`${JSON.stringify({ type: 'synthesize', id: 'boom', index: 3, text: 'Hello.', voice: 'nope' })}\n`)
    await waitFor(() => frames.length === 1)
    input.end()
    await running
    expect(frames[0]).toMatchObject({ type: 'error', id: 'boom', message: 'voice is unavailable' })
  })

  it('stringifies a non-error rejection', async () => {
    const input = new PassThrough()
    const { output, frames } = frameReader()
    const running = runWorker(fakeBackend({
      synthesize: async () => { throw 'plain text' },
    }), input, output)
    input.write(`${JSON.stringify({ type: 'synthesize', id: 'boom', index: 0, text: 'Hello.', voice: 'v' })}\n`)
    await waitFor(() => frames.length === 1)
    input.end()
    await running
    expect(frames[0]?.message).toBe('plain text')
  })
})

describe('main', () => {
  it('loads the backend, publishes readiness, and then serves requests', async () => {
    const input = new PassThrough()
    const { output, frames } = frameReader()
    const configs: Array<{ modelDirectory: string; voice: string }> = []
    const running = main(['node', 'worker', JSON.stringify({ modelDirectory: '/models/kokoro', voice: 'af_heart' })],
      input, output, async (config) => {
        configs.push(config)
        return fakeBackend()
      })
    await waitFor(() => frames.length === 1)
    expect(frames[0]).toEqual({ type: 'ready', sampleRate: 24_000 })
    expect(configs).toEqual([{ modelDirectory: '/models/kokoro', voice: 'af_heart' }])
    input.write(`${JSON.stringify({ type: 'synthesize', id: 'a', index: 0, text: 'Hello.', voice: 'af_heart' })}\n`)
    await waitFor(() => frames.length === 2)
    input.end()
    await running
  })

  it('rejects a missing launch configuration before loading a backend', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    await expect(main(['node', 'worker'], input, output, async () => fakeBackend())).rejects.toThrow('configuration is missing')
  })
})

describe('worker entry', () => {
  const entry = fileURLToPath(new URL('../src/engine/tts-worker.ts', import.meta.url))

  /** Launch the worker entry and collect its complete output. */
  async function launch(argument?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const args = ['--import', import.meta.resolve('tsx/esm'), entry]
    if (argument !== undefined) args.push(argument)
    const child = spawn(process.execPath, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { code, stdout, stderr }
  }

  it.each([
    ['a missing launch argument', undefined, 'configuration is missing'],
    ['malformed launch JSON', '{', 'JSON'],
    ['a configuration without a model directory', JSON.stringify({ voice: 'af_heart' }), 'modelDirectory'],
  ])('exits 1 before readiness on %s', async (_case, argument, message) => {
    const exit = await launch(argument)
    expect(exit.code).toBe(1)
    expect(exit.stdout).toBe('')
    expect(exit.stderr).toContain(message)
    expect(exit.stderr.endsWith('\n')).toBe(true)
    expect(exit.stderr).not.toMatch(/^\s+at /mu)
  }, 30_000)

  it('exits 1 without touching the native runtime when the model is missing', async () => {
    const directory = await tempDirectory()
    const exit = await launch(JSON.stringify({ modelDirectory: directory, voice: 'af_heart' }))
    expect(exit.code).toBe(1)
    expect(exit.stdout).toBe('')
    expect(exit.stderr).toContain('Kokoro model is missing')
  }, 30_000)
})
