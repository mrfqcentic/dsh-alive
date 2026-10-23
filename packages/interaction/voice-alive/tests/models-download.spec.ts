/** Download policy: resume, restart, checksum gate, atomic finalize, cancel, typed failures. */
import { expect, it } from 'vitest'
import type { DownloadProgress } from '../src/models/host/download.ts'
import { downloadModel } from '../src/models/host/download.ts'
import type { ModelTransport } from '../src/models/host/transport.ts'
import { ModelStoreError } from '../src/models/host/errors.ts'
import type { ModelRecord } from '../src/models/types.ts'
import { bytes, createFakeTransport, createMemoryFileSystem, payload, sha256, type ServedBody } from './support/models-fakes.ts'

const ENCODER = payload(4)
const DECODER = payload(6)
const TOTAL = ENCODER.byteLength + DECODER.byteLength

const RECORD: ModelRecord = {
  id: 'whisper-base',
  kind: 'asr',
  engine: 'whisper',
  name: 'Whisper test',
  summary: 'Two tiny files.',
  languages: ['English'],
  required: true,
  license: 'MIT',
  attribution: 'test fixture',
  files: [
    { path: 'encoder.int8.onnx', url: 'https://models.test/encoder', bytes: ENCODER.byteLength, sha256: sha256(ENCODER) },
    { path: 'decoder.int8.onnx', url: 'https://models.test/decoder', bytes: DECODER.byteLength, sha256: sha256(DECODER) },
  ],
}

const ROOT = '/models'
const STAGING = '/models/.staging/whisper-base'
const TARGET = '/models/whisper-base'
const ENCODER_PART = `${STAGING}/encoder.int8.onnx.part`
const ENCODER_FINAL = `${STAGING}/encoder.int8.onnx`
const DECODER_PART = `${STAGING}/decoder.int8.onnx.part`

/** Serve the real bytes of both files, honoring the resume offset. */
function servePinned(url: string, offset: number): ServedBody {
  const value = url.endsWith('encoder') ? ENCODER : DECODER
  return { chunks: [value.slice(offset)], status: offset === 0 ? 200 : 206 }
}

/** @param signal - cancellation signal for the run. @param serve - scripted server. @param seed - pre-existing files. */
function setup(serve: (url: string, offset: number, signal: AbortSignal) => ServedBody = servePinned,
  seed: Record<string, Uint8Array> = {}, signal = new AbortController().signal) {
  const fs = createMemoryFileSystem(seed)
  const transport = createFakeTransport(serve)
  const progress: DownloadProgress[] = []
  const run = (): Promise<string> => downloadModel({
    record: RECORD,
    root: ROOT,
    fs,
    transport,
    signal,
    onProgress: (value) => { progress.push(value) },
  })
  return { fs, transport, progress, run }
}

/**
 * Await one rejected run.
 * @param run - download promise expected to reject.
 * @returns the typed failure.
 */
async function rejection(run: Promise<unknown>): Promise<ModelStoreError> {
  try {
    await run
  } catch (error) {
    if (error instanceof ModelStoreError) return error
    throw error
  }
  throw new Error('the download was expected to fail')
}

it('downloads every file into the final directory and reports progress', async () => {
  const { fs, transport, progress, run } = setup()
  await expect(run()).resolves.toBe(TARGET)

  expect(fs.files.get(`${TARGET}/encoder.int8.onnx`)).toEqual(ENCODER)
  expect(fs.files.get(`${TARGET}/decoder.int8.onnx`)).toEqual(DECODER)
  expect(fs.files.has(STAGING)).toBe(false)
  expect(fs.files.has(ENCODER_PART)).toBe(false)
  expect(transport.calls.map(call => call.offset)).toEqual([0, 0])
  expect(progress[0]).toEqual({ receivedBytes: 0, totalBytes: TOTAL })
  expect(progress.at(-1)).toEqual({ receivedBytes: TOTAL, totalBytes: TOTAL })
})

it('never re-downloads a verified file kept from an earlier attempt', async () => {
  const { fs, transport, progress, run } = setup(servePinned, { [ENCODER_FINAL]: ENCODER })
  await expect(run()).resolves.toBe(TARGET)
  expect(transport.calls).toEqual([{ url: 'https://models.test/decoder', offset: 0 }])
  expect(fs.files.get(`${TARGET}/encoder.int8.onnx`)).toEqual(ENCODER)
  expect(progress[1]).toEqual({ receivedBytes: ENCODER.byteLength, totalBytes: TOTAL })
})

it('discards a final file whose bytes do not match the pin', async () => {
  const { fs, transport, run } = setup(servePinned, { [ENCODER_FINAL]: bytes('zzzz') })
  await expect(run()).resolves.toBe(TARGET)
  expect(transport.calls.map(call => call.url)).toEqual(['https://models.test/encoder', 'https://models.test/decoder'])
  expect(fs.files.get(`${TARGET}/encoder.int8.onnx`)).toEqual(ENCODER)
})

it('resumes a partial file from its byte offset', async () => {
  const { fs, transport, progress, run } = setup(servePinned, { [ENCODER_PART]: ENCODER.slice(0, 2) })
  await expect(run()).resolves.toBe(TARGET)
  expect(transport.calls[0]).toEqual({ url: 'https://models.test/encoder', offset: 2 })
  expect(fs.files.get(`${TARGET}/encoder.int8.onnx`)).toEqual(ENCODER)
  expect(progress.at(-1)).toEqual({ receivedBytes: TOTAL, totalBytes: TOTAL })
})

it('restarts a partial file the server refuses to continue', async () => {
  const requests: number[] = []
  const { fs, run } = setup((url, offset) => {
    requests.push(offset)
    return offset === ENCODER.byteLength ? { status: 416, chunks: [] } : servePinned(url, offset)
  }, { [ENCODER_PART]: ENCODER })
  await expect(run()).resolves.toBe(TARGET)
  expect(requests.slice(0, 2)).toEqual([ENCODER.byteLength, 0])
  expect(fs.files.has(ENCODER_PART)).toBe(false)
  expect(fs.files.get(`${TARGET}/encoder.int8.onnx`)).toEqual(ENCODER)
})

it('restarts when the server ignores the range and sends the whole file', async () => {
  const { fs, transport, run } = setup((url) => {
    const value = url.endsWith('encoder') ? ENCODER : DECODER
    return { status: 200, chunks: [value] }
  }, { [ENCODER_PART]: ENCODER.slice(0, 2) })
  await expect(run()).resolves.toBe(TARGET)
  expect(transport.calls[0]?.offset).toBe(2)
  expect(fs.files.get(`${TARGET}/encoder.int8.onnx`)).toEqual(ENCODER)
})

it('restarts a partial file longer than the pinned size', async () => {
  const { fs, transport, run } = setup(servePinned, { [ENCODER_PART]: payload(120) })
  await expect(run()).resolves.toBe(TARGET)
  expect(transport.calls[0]?.offset).toBe(0)
  expect(fs.count('remove', ENCODER_PART)).toBe(1)
  expect(fs.files.get(`${TARGET}/encoder.int8.onnx`)).toEqual(ENCODER)
})

it('removes the payload on a hash mismatch', async () => {
  const { fs, run } = setup((url, offset) => {
    if (url.endsWith('decoder')) return { chunks: [bytes('xxxxxx')], status: 200 }
    return servePinned(url, offset)
  })
  const error = await rejection(run())
  expect(error.code).toBe('hash-mismatch')
  expect(fs.files.has(DECODER_PART)).toBe(false)
  expect(fs.files.get(ENCODER_FINAL)).toEqual(ENCODER)
})

it('keeps the partial payload when the body ends short', async () => {
  const { fs, run } = setup(() => ({ chunks: [ENCODER.slice(0, 2)], status: 200 }))
  const error = await rejection(run())
  expect(error.code).toBe('network')
  expect(fs.files.get(ENCODER_PART)).toEqual(ENCODER.slice(0, 2))
})

it('refuses a body larger than the pinned size', async () => {
  const { fs, run } = setup(() => ({ chunks: [payload(9)], status: 200 }))
  const error = await rejection(run())
  expect(error.code).toBe('size-mismatch')
  expect(fs.files.has(ENCODER_FINAL)).toBe(false)
})

it('reports a rejected request as a network failure', async () => {
  const { run } = setup(() => ({ error: new Error('connection reset') }))
  const error = await rejection(run())
  expect(error.code).toBe('network')
  expect(error.message).toContain('connection reset')
})

it('reports a refused status as a network failure', async () => {
  const { run } = setup(() => ({ status: 503, chunks: [] }))
  await expect(rejection(run()).then(error => error.code)).resolves.toBe('network')
})

it('reports a response without a body as a network failure', async () => {
  const { run } = setup(() => ({ empty: true, status: 204 }))
  const error = await rejection(run())
  expect(error.code).toBe('network')
  expect(error.message).toContain('204')
})

it('refuses immediately when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const { transport, run } = setup(servePinned, {}, controller.signal)
  await expect(rejection(run()).then(error => error.code)).resolves.toBe('cancelled')
  expect(transport.calls).toHaveLength(0)
})

it('stops a download cancelled during the transfer', async () => {
  const controller = new AbortController()
  const { fs, transport, run } = setup((url, offset) => {
    controller.abort()
    return servePinned(url, offset)
  }, {}, controller.signal)
  await expect(rejection(run()).then(error => error.code)).resolves.toBe('cancelled')
  expect(transport.calls).toHaveLength(1)
  expect(fs.files.has(`${TARGET}/decoder.int8.onnx`)).toBe(false)
})

it('reports a request rejected after cancellation as cancelled', async () => {
  const controller = new AbortController()
  const { run } = setup(() => {
    controller.abort()
    return { error: new Error('The operation was aborted') }
  }, {}, controller.signal)
  await expect(rejection(run()).then(error => error.code)).resolves.toBe('cancelled')
})

it('reports an interrupted stream as a network failure', async () => {
  const fs = createMemoryFileSystem()
  const transport: ModelTransport = {
    async get() {
      return {
        status: 200,
        body: (async function* (): AsyncGenerator<Uint8Array> {
          yield ENCODER.slice(0, 2)
          throw new Error('socket hang up')
        })(),
      }
    },
  }
  const error = await rejection(downloadModel({
    record: RECORD,
    root: ROOT,
    fs,
    transport,
    signal: new AbortController().signal,
    onProgress: () => {},
  }))
  expect(error.code).toBe('network')
  expect(error.message).toContain('socket hang up')
})

it('reports a filesystem rejection as a disk failure', async () => {
  const { fs, run } = setup()
  fs.fail(operation => operation === 'mkdir', Object.assign(new Error('read only'), { code: 'EROFS' }))
  const error = await rejection(run())
  expect(error.code).toBe('disk')
  expect(error.message).toContain('EROFS')
})

it('reports a write rejection as a disk failure', async () => {
  const { fs, run } = setup()
  fs.fail(operation => operation === 'sink-write', new Error('no space left'))
  const error = await rejection(run())
  expect(error.code).toBe('disk')
  expect(error.message).toContain('no space left')
})

it('reports a close rejection as a disk failure', async () => {
  const { fs, run } = setup()
  fs.fail(operation => operation === 'close', new Error('flush failed'))
  await expect(rejection(run()).then(error => error.code)).resolves.toBe('disk')
})

it('replaces a directory that appeared while the download ran', async () => {
  const { fs, run } = setup(servePinned, { [`${TARGET}/stale.bin`]: bytes('stale') })
  await expect(run()).resolves.toBe(TARGET)
  expect(fs.files.has(`${TARGET}/stale.bin`)).toBe(false)
  expect(fs.files.get(`${TARGET}/encoder.int8.onnx`)).toEqual(ENCODER)
})
