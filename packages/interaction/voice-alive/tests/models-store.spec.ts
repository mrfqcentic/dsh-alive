/** Host model store: verification, readiness, download lifecycle, remove, activation. */
import { expect, it } from 'vitest'
import { SUPPORTED_PLATFORM, createModelStore } from '../src/models/host/store.ts'
import type { ModelStore } from '../src/models/host/store.ts'
import type { ModelId } from '../src/models/types.ts'
import {
  bytes,
  createFakeTransport,
  createMemoryFileSystem,
  payload,
  type FakeTransport,
  type MemoryFileSystem,
  type ServedBody,
} from './support/models-fakes.ts'
import {
  CATALOG,
  KOKORO,
  KOKORO_BYTES,
  ROOT,
  WHISPER,
  WHISPER_BYTES,
  installed,
  servePinned,
} from './support/models-fixtures.ts'

/** @param options - initial files, scripted server, and host identity. */
function setup(options: {
  seed?: Record<string, Uint8Array>
  serve?: (url: string, offset: number) => ServedBody | Promise<ServedBody>
  platform?: string
} = {}): { store: ModelStore; fs: MemoryFileSystem; transport: FakeTransport } {
  const fs = createMemoryFileSystem(options.seed ?? {})
  const transport = createFakeTransport(options.serve ?? servePinned)
  const store = createModelStore({
    root: ROOT,
    platform: options.platform ?? SUPPORTED_PLATFORM,
    fs,
    transport,
    catalog: CATALOG,
  })
  return { store, fs, transport }
}

/** @param views - store snapshot. @param id - catalog id. @returns the row for that id. */
function row(views: ReturnType<ModelStore['list']>, id: ModelId) {
  const found = views.find(view => view.id === id)
  if (found === undefined) throw new Error(`no row for ${id}`)
  return found
}

it('starts with every entry absent and catalog metadata', () => {
  const { store } = setup()
  expect(store.list().map(view => view.id)).toEqual(['whisper-base', 'parakeet-v3', 'kokoro'])
  expect(store.status('kokoro')).toEqual({
    id: 'kokoro',
    kind: 'tts',
    name: 'Kokoro test',
    summary: 'Required voice fixture.',
    languages: ['English'],
    required: true,
    bytes: KOKORO_BYTES.byteLength,
    state: 'absent',
    receivedBytes: 0,
    failure: null,
  })
})

it('rejects an unknown catalog id', () => {
  const { store } = setup()
  expect(() => store.status('missing' as ModelId)).toThrow(expect.objectContaining({ code: 'unknown-model' }))
})

it('refuses work on an unsupported host', async () => {
  const { store, fs } = setup({ platform: 'linux-x64' })
  expect(store.supported).toBe(false)
  expect(store.readiness()).toMatchObject({ ready: false, failure: { code: 'unsupported-platform' } })
  await expect(store.download('kokoro')).rejects.toThrow(expect.objectContaining({ code: 'unsupported-platform' }))
  await store.initialize()
  expect(fs.calls).toHaveLength(0)
})

it('verifies an installed directory and reports the required set ready', async () => {
  const { store } = setup({ seed: { ...installed(WHISPER), ...installed(KOKORO) } })
  await store.initialize()
  expect(store.status('whisper-base')).toMatchObject({ state: 'ready', receivedBytes: WHISPER_BYTES.byteLength })
  expect(store.status('kokoro')).toMatchObject({ state: 'ready' })
  expect(store.readiness()).toEqual({ ready: true, asr: 'whisper-base', tts: 'kokoro', failure: null })
  expect(store.selection()).toEqual({
    asr: { id: 'whisper', directory: `${ROOT}/whisper-base` },
    tts: { directory: `${ROOT}/kokoro` },
  })
})

it('publishes the verifying step while hashing a directory', async () => {
  const { store } = setup({ seed: installed(WHISPER) })
  const states: string[] = []
  store.subscribe((views) => { states.push(row(views, 'whisper-base').state) })
  await store.initialize()
  expect(states).toEqual(['absent', 'verifying', 'ready'])
})

it('marks a truncated file as an error', async () => {
  const seed = { ...installed(WHISPER) }
  seed[`${ROOT}/whisper-base/whisper-base.bin`] = WHISPER_BYTES.slice(0, 2)
  const { store } = setup({ seed })
  await store.initialize()
  expect(store.status('whisper-base')).toMatchObject({ state: 'error', failure: { code: 'size-mismatch' } })
  expect(store.selection()).toBeNull()
})

it('marks a file with the wrong bytes as an error', async () => {
  const seed = { ...installed(WHISPER) }
  seed[`${ROOT}/whisper-base/whisper-base.bin`] = payload(4).reverse()
  const { store } = setup({ seed })
  await store.initialize()
  expect(store.status('whisper-base')).toMatchObject({ state: 'error', failure: { code: 'hash-mismatch' } })
})

it('marks an unreadable directory as a disk error', async () => {
  const { store, fs } = setup({ seed: installed(WHISPER) })
  fs.fail(operation => operation === 'exists', Object.assign(new Error('denied'), { code: 'EACCES' }))
  await store.initialize()
  expect(store.status('whisper-base')).toMatchObject({ state: 'error', failure: { code: 'disk' } })
})

it('marks an unreadable file as a disk error', async () => {
  const { store, fs } = setup({ seed: installed(WHISPER) })
  fs.fail(operation => operation === 'hash', new Error('input/output error'))
  await store.initialize()
  expect(store.status('whisper-base')).toMatchObject({ state: 'error', failure: { code: 'disk' } })
})

it('verifies each directory once', async () => {
  const { store, fs } = setup({ seed: installed(WHISPER) })
  await store.initialize()
  await store.initialize()
  expect(fs.count('exists', `${ROOT}/whisper-base`)).toBe(1)
})

it('downloads an entry, publishing progress and the ready state', async () => {
  const { store, transport } = setup()
  const states: string[] = []
  const received: number[] = []
  store.subscribe((views) => {
    states.push(row(views, 'kokoro').state)
    received.push(row(views, 'kokoro').receivedBytes)
  })
  await store.download('kokoro')
  expect(states.filter((state, index) => state !== states[index - 1])).toEqual(['absent', 'downloading', 'ready'])
  expect(received).toContain(KOKORO_BYTES.byteLength)
  expect(store.status('kokoro').receivedBytes).toBe(KOKORO_BYTES.byteLength)
  expect(transport.calls).toEqual([{ url: 'https://models.test/kokoro', offset: 0 }])
})

it('blocks readiness on a missing kind and names it', async () => {
  const asrOnly = setup({ seed: installed(WHISPER) })
  await asrOnly.store.initialize()
  expect(asrOnly.store.readiness()).toMatchObject({ ready: false, failure: { code: 'tts-missing' } })

  const ttsOnly = setup({ seed: installed(KOKORO) })
  await ttsOnly.store.initialize()
  expect(ttsOnly.store.readiness()).toMatchObject({ ready: false, failure: { code: 'asr-missing' } })
  expect(ttsOnly.store.selection()).toBeNull()
})

it('records a failed download on the entry', async () => {
  const { store } = setup({ serve: () => ({ status: 200, chunks: [bytes('nope!!!!')] }) })
  await expect(store.download('kokoro')).rejects.toThrow(expect.objectContaining({ code: 'hash-mismatch' }))
  expect(store.status('kokoro')).toMatchObject({ state: 'error', failure: { code: 'hash-mismatch' } })
})

it('refuses to download an installed entry or a running one', async () => {
  const installedStore = setup({ seed: installed(KOKORO) })
  await installedStore.store.initialize()
  await expect(installedStore.store.download('kokoro')).rejects.toThrow(expect.objectContaining({ code: 'state' }))

  const gate = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const { store } = setup({
    serve: async () => {
      started.resolve(undefined)
      await gate.promise
      return servePinned('https://models.test/kokoro', 0)
    },
  })
  const first = store.download('kokoro')
  await started.promise
  await expect(store.download('kokoro')).rejects.toThrow(expect.objectContaining({ code: 'state' }))
  gate.resolve(undefined)
  await first
})

it('cancels a running download and discards the partial payload', async () => {
  const gate = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const { store, fs } = setup({
    serve: async () => {
      started.resolve(undefined)
      await gate.promise
      return servePinned('https://models.test/kokoro', 0)
    },
  })
  const run = store.download('kokoro')
  await started.promise
  store.cancel('kokoro')
  gate.resolve(undefined)
  await expect(run).rejects.toThrow(expect.objectContaining({ code: 'cancelled' }))
  expect(store.status('kokoro').state).toBe('absent')
  expect([...fs.files.keys()].some(path => path.startsWith(`${ROOT}/.staging`))).toBe(false)
})

it('ignores a cancel for an entry that is not downloading', () => {
  const { store } = setup()
  expect(() => { store.cancel('kokoro') }).not.toThrow()
})

it('removes an installed model and blocks readiness again', async () => {
  const { store, fs } = setup({ seed: { ...installed(WHISPER), ...installed(KOKORO) } })
  await store.initialize()
  await store.remove('kokoro')
  expect(store.status('kokoro').state).toBe('absent')
  expect(fs.files.has(`${ROOT}/kokoro/kokoro.bin`)).toBe(false)
  expect(store.readiness()).toMatchObject({ ready: false, failure: { code: 'tts-missing' } })
})

it('removes a model while its download is still running', async () => {
  const gate = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const { store, fs } = setup({
    serve: async () => {
      started.resolve(undefined)
      await gate.promise
      return servePinned('https://models.test/kokoro', 0)
    },
  })
  const run = store.download('kokoro')
  await started.promise
  const removal = store.remove('kokoro')
  gate.resolve(undefined)
  await expect(run).rejects.toThrow(expect.objectContaining({ code: 'cancelled' }))
  await removal
  expect(store.status('kokoro').state).toBe('absent')
  expect(fs.files.size).toBe(0)
})

it('blocks on a chosen model that is not installed instead of falling back', async () => {
  const { store } = setup({ seed: { ...installed(WHISPER), ...installed(KOKORO) } })
  await store.initialize()
  store.activate('parakeet-v3')
  expect(store.readiness()).toMatchObject({ ready: false, failure: { code: 'active-model-missing' } })
  expect(store.selection()).toBeNull()

  await store.download('parakeet-v3')
  expect(store.readiness()).toEqual({ ready: true, asr: 'parakeet-v3', tts: 'kokoro', failure: null })
  expect(store.selection()?.asr).toEqual({ id: 'parakeet', directory: `${ROOT}/parakeet-v3` })
})

it('rejects an unknown activation', () => {
  const { store } = setup()
  expect(() => { store.activate('missing' as ModelId) }).toThrow(expect.objectContaining({ code: 'unknown-model' }))
})

it('reports a directory that lacks a pinned file', async () => {
  const { store } = setup({ seed: { [`${ROOT}/whisper-base/notes.txt`]: new Uint8Array() } })
  await store.initialize()
  expect(store.status('whisper-base')).toMatchObject({ state: 'error', failure: { code: 'size-mismatch' } })
})

it('reports a failed cleanup after a cancelled download', async () => {
  const gate = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const { store, fs } = setup({
    serve: async () => {
      started.resolve(undefined)
      await gate.promise
      return servePinned('https://models.test/kokoro', 0)
    },
  })
  const run = store.download('kokoro')
  await started.promise
  fs.fail(operation => operation === 'remove', new Error('busy'))
  store.cancel('kokoro')
  gate.resolve(undefined)
  await expect(run).rejects.toThrow(expect.objectContaining({ code: 'cancelled' }))
  expect(store.status('kokoro')).toMatchObject({ state: 'error', failure: { code: 'disk' } })
})

it('stops notifying an unsubscribed listener', async () => {
  const { store } = setup({ seed: installed(WHISPER) })
  let calls = 0
  const unsubscribe = store.subscribe(() => { calls++ })
  expect(calls).toBe(1)
  unsubscribe()
  await store.initialize()
  expect(calls).toBe(1)
})
