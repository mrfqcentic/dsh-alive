/** Readiness gate: the supervisor is configured only from a verified selection. */
import { expect, it } from 'vitest'
import { configureSupervisor, requireSelection } from '../src/models/host/gate.ts'
import { createModelStore } from '../src/models/host/store.ts'
import type { ModelStore, ModelStoreOptions } from '../src/models/host/store.ts'
import type { ModelSelection } from '../src/models/types.ts'
import { createFakeTransport, createMemoryFileSystem } from './support/models-fakes.ts'
import { CATALOG, KOKORO, ROOT, WHISPER, installed, servePinned } from './support/models-fixtures.ts'

/** @param options - initial files and host identity. */
function setup(options: { seed?: Record<string, Uint8Array>; platform?: string } = {}): ModelStore {
  return createModelStore({
    root: ROOT,
    platform: options.platform ?? 'darwin-arm64',
    fs: createMemoryFileSystem(options.seed ?? {}),
    transport: createFakeTransport(servePinned),
    catalog: CATALOG,
  } satisfies ModelStoreOptions)
}

it('refuses before any engine work while a recognizer is missing', async () => {
  const store = setup({ seed: installed(KOKORO) })
  await expect(requireSelection(store)).rejects.toThrow(expect.objectContaining({ code: 'asr-missing' }))
})

it('refuses while Kokoro is missing', async () => {
  const store = setup({ seed: installed(WHISPER) })
  await expect(requireSelection(store)).rejects.toThrow(expect.objectContaining({ code: 'tts-missing' }))
})

it('refuses a chosen model that is not installed', async () => {
  const store = setup({ seed: { ...installed(WHISPER), ...installed(KOKORO) } })
  await store.initialize()
  store.activate('parakeet-v3')
  await expect(requireSelection(store)).rejects.toThrow(expect.objectContaining({ code: 'active-model-missing' }))
})

it('refuses an unsupported host', async () => {
  const store = setup({ platform: 'linux-x64' })
  await expect(requireSelection(store)).rejects.toThrow(expect.objectContaining({ code: 'unsupported-platform' }))
})

it('verifies an installed directory before returning the selection', async () => {
  const store = setup({ seed: { ...installed(WHISPER), ...installed(KOKORO) } })
  await expect(requireSelection(store)).resolves.toEqual({
    asr: { id: 'whisper', directory: `${ROOT}/whisper-base` },
    tts: { directory: `${ROOT}/kokoro` },
  })
})

it('configures the supervisor with the verified selection', async () => {
  const store = setup({ seed: { ...installed(WHISPER), ...installed(KOKORO) } })
  const configured: ModelSelection[] = []
  await configureSupervisor(store, {
    async configure(selection) {
      configured.push(selection)
    },
  })
  expect(configured).toHaveLength(1)
  expect(configured[0]?.asr).toEqual({ id: 'whisper', directory: `${ROOT}/whisper-base` })
})

it('never reaches the supervisor while the required set is incomplete', async () => {
  const store = setup()
  let configured = 0
  await expect(configureSupervisor(store, {
    async configure() {
      configured++
    },
  })).rejects.toThrow(expect.objectContaining({ code: 'asr-missing' }))
  expect(configured).toBe(0)
})
