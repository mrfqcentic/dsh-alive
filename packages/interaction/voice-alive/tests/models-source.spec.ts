/** Catalog source over the shell bridge: detection, validation, and action forwarding. */
import { expect, it } from 'vitest'
import {
  MODELS_PROTOCOL_VERSION,
  createModelCatalogSource,
  parseSnapshot,
} from '../src/client/settings/models-source.ts'
import type {
  ModelRowFailure,
  ModelRowView,
  ModelSnapshot,
  VoiceModelsBridgeApi,
} from '../src/client/settings/models-source.ts'

/** @param overrides - row fields to replace. @returns one valid catalog row. */
function row(overrides: Partial<ModelRowView> = {}): ModelRowView {
  return {
    id: 'kokoro',
    kind: 'tts',
    name: 'Kokoro',
    summary: 'Voice synthesizer.',
    languages: ['English'],
    required: true,
    bytes: 100,
    state: 'ready',
    receivedBytes: 100,
    failure: null,
    ...overrides,
  }
}

/** @param overrides - snapshot fields to replace. @returns one valid snapshot. */
function snapshot(overrides: Partial<ModelSnapshot> = {}): ModelSnapshot {
  return { rows: [row()], readiness: { ready: true, asr: 'whisper-base', tts: 'kokoro', failure: null }, ...overrides }
}

/** @param overrides - bridge methods to replace. @returns a versioned shell bridge. */
function bridge(overrides: Partial<VoiceModelsBridgeApi> = {}): VoiceModelsBridgeApi {
  return { protocolVersion: MODELS_PROTOCOL_VERSION, ...overrides }
}

/** A frame whose rows field is mistyped on the wire, as a broken bridge would send it. */
const MALFORMED_SNAPSHOT = JSON.parse(
  '{"rows":"nope","readiness":{"ready":false,"asr":null,"tts":null,"failure":null}}',
) as ModelSnapshot

/** Let the pending request settle. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

it('is unsupported without a compatible bridge', () => {
  expect(createModelCatalogSource(() => undefined).supported).toBe(false)
  expect(createModelCatalogSource(() => bridge({ protocolVersion: 2 })).supported).toBe(false)
  expect(createModelCatalogSource(() => bridge()).supported).toBe(true)
})

it('starts from an empty, not-ready snapshot', () => {
  const source = createModelCatalogSource(() => undefined)
  expect(source.snapshot()).toEqual({
    rows: [],
    readiness: { ready: false, asr: null, tts: null, failure: null },
  })
})

it('asks for the current state once and publishes it', async () => {
  let requests = 0
  const api = bridge({ state: async () => { requests++; return snapshot() } })
  const source = createModelCatalogSource(() => api)
  const notifications: number[] = []
  const unsubscribe = source.subscribe(() => { notifications.push(requests) })
  await flush()
  expect(requests).toBe(1)
  expect(source.snapshot().rows).toHaveLength(1)
  expect(notifications).toHaveLength(1)

  const second = source.subscribe(() => {})
  await flush()
  expect(requests).toBe(1)
  second()
  unsubscribe()
})

it('publishes pushed snapshots, replacing the stale row, and detaches with the last subscriber', async () => {
  let push: ((value: ModelSnapshot) => void) | undefined
  let detached = 0
  const api = bridge({
    state: async () => snapshot(),
    subscribe(listener) {
      push = listener
      return () => { detached++ }
    },
  })
  const source = createModelCatalogSource(() => api)
  const unsubscribe = source.subscribe(() => {})
  await flush()
  push?.(snapshot({
    rows: [row({ state: 'downloading', receivedBytes: 25 })],
    readiness: { ready: false, asr: null, tts: null, failure: { code: 'asr-missing', message: 'missing' } },
  }))
  expect(source.snapshot().rows[0]).toMatchObject({ state: 'downloading', receivedBytes: 25 })
  expect(source.snapshot().readiness.ready).toBe(false)

  unsubscribe()
  expect(detached).toBe(1)

  source.subscribe(() => {})
  await flush()
})

it('reports a Host that serves no model store as unsupported', async () => {
  const source = createModelCatalogSource(() => bridge({ state: async () => null }))
  let notified = 0
  source.subscribe(() => { notified++ })
  await flush()

  expect(notified).toBe(1)
  expect(source.supported).toBe(false)
  expect(source.snapshot().rows).toHaveLength(0)
})

it('reports a closed channel as unsupported instead of pretending the Host has no models', async () => {
  const source = createModelCatalogSource(() => bridge({ state: async () => { throw new Error('channel closed') } }))
  let notified = 0
  source.subscribe(() => { notified++ })
  await flush()

  expect(notified).toBe(1)
  expect(source.supported).toBe(false)
})

it('drops a malformed state response and reports the Host as unsupported', async () => {
  // The payload crosses a process boundary, so a malformed frame must never reach the pane.
  const source = createModelCatalogSource(() => bridge({ state: async () => MALFORMED_SNAPSHOT }))
  let notified = 0
  source.subscribe(() => { notified++ })
  await flush()
  expect(notified).toBe(1)
  expect(source.supported).toBe(false)
  expect(source.snapshot().rows).toHaveLength(0)
})

it('drops a malformed pushed frame and keeps the last good snapshot', async () => {
  let push: ((value: ModelSnapshot) => void) | undefined
  const api = bridge({
    state: async () => snapshot(),
    subscribe(listener) { push = listener; return () => {} },
  })
  const source = createModelCatalogSource(() => api)
  source.subscribe(() => {})
  await flush()

  push?.(MALFORMED_SNAPSHOT)

  expect(source.snapshot().rows).toHaveLength(1)
  expect(source.supported).toBe(true)
})

it('works without state or subscription methods', async () => {
  const source = createModelCatalogSource(() => bridge())
  const notifications: number[] = []
  const unsubscribe = source.subscribe(() => { notifications.push(1) })
  await flush()
  expect(source.snapshot().rows).toHaveLength(0)
  expect(notifications).toHaveLength(0)
  expect(source.supported).toBe(true)
  unsubscribe()
})

it('forwards every action and drops a broken channel', async () => {
  const calls: string[] = []
  const api = bridge({
    state: async () => snapshot(),
    download: async (id) => { calls.push(`download:${id}`) },
    cancel: async (id) => { calls.push(`cancel:${id}`) },
    remove: async (id) => { calls.push(`remove:${id}`) },
    activate: async (id) => { calls.push(`activate:${id}`) },
  })
  const source = createModelCatalogSource(() => api)
  await source.download('kokoro')
  source.cancel('kokoro')
  await source.remove('kokoro')
  await source.activate('kokoro')
  await flush()
  expect(calls).toEqual(['download:kokoro', 'cancel:kokoro', 'remove:kokoro', 'activate:kokoro'])

  const broken = createModelCatalogSource(() => bridge({
    download: async () => { throw new Error('closed') },
    cancel: async () => { throw new Error('closed') },
    remove: async () => { throw new Error('closed') },
    activate: async () => { throw new Error('closed') },
  }))
  await expect(broken.download('kokoro')).resolves.toBeUndefined()
  broken.cancel('kokoro')
  await expect(broken.remove('kokoro')).resolves.toBeUndefined()
  await expect(broken.activate('kokoro')).resolves.toBeUndefined()
  await flush()
})

it('treats an absent action as a no-op', async () => {
  for (const read of [() => bridge(), () => undefined]) {
    const source = createModelCatalogSource(read)
    await expect(source.download('kokoro')).resolves.toBeUndefined()
    expect(() => { source.cancel('kokoro') }).not.toThrow()
    await expect(source.remove('kokoro')).resolves.toBeUndefined()
    await expect(source.activate('kokoro')).resolves.toBeUndefined()
  }
})

const CODES: readonly ModelRowFailure['code'][] = [
  'network',
  'disk',
  'hash-mismatch',
  'size-mismatch',
  'unsupported-platform',
  'cancelled',
  'unknown-model',
  'state',
  'asr-missing',
  'tts-missing',
  'active-model-missing',
  'internal',
]

it.each(CODES)('keeps the %s failure code and message for the pane', (code) => {
  const failure = { code, message: 'host detail' }
  const parsed = parseSnapshot(snapshot({
    rows: [row({ state: 'error', failure })],
    readiness: { ready: false, asr: null, tts: null, failure },
  }))

  expect(parsed?.rows[0]?.failure).toEqual(failure)
  expect(parsed?.readiness.failure).toEqual(failure)
})

it('accepts a snapshot without a bridge subscriber', () => {
  expect(parseSnapshot(snapshot())).toEqual(snapshot())
})

const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
  ['not an object', 'snapshot'],
  ['an array', []],
  ['no rows', {}],
  ['rows not an array', { rows: {}, readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['no readiness', { rows: [] }],
  ['readiness not an object', { rows: [], readiness: 'ready' }],
  ['row not an object', { rows: ['row'], readiness: { ready: false, asr: null, tts: null, failure: null } }],
  ['row without an id', { rows: [{ ...row(), id: 1 }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row without a name', { rows: [{ ...row(), name: null }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row without a summary', { rows: [{ ...row(), summary: 3 }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row with an unknown kind', { rows: [{ ...row(), kind: 'video' }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row without a required flag', { rows: [{ ...row(), required: 'yes' }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row with a string size', { rows: [{ ...row(), bytes: '100' }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row with a string progress', { rows: [{ ...row(), receivedBytes: '1' }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row with an unknown state', { rows: [{ ...row(), state: 'paused' }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row without languages', { rows: [{ ...row(), languages: 'en' }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row with a non-string language', { rows: [{ ...row(), languages: [1] }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row with a non-object failure', { rows: [{ ...row(), failure: 'broken' }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row with a broken failure', { rows: [{ ...row(), failure: { code: 1 } }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['row with an empty failure', { rows: [{ ...row(), failure: {} }], readiness: { ready: true, asr: null, tts: null, failure: null } }],
  ['readiness without a flag', { rows: [], readiness: { asr: null, tts: null, failure: null } }],
  ['readiness without a recognizer', { rows: [], readiness: { ready: false, tts: null, failure: null } }],
  ['readiness with a mistyped voice', { rows: [], readiness: { ready: false, asr: null, tts: 3, failure: null } }],
  ['readiness with a broken failure', { rows: [], readiness: { ready: false, asr: null, tts: null, failure: { code: 'x' } } }],
]

it.each(MALFORMED)('rejects a malformed snapshot: %s', (_name, value) => {
  expect(parseSnapshot(value)).toBeNull()
})
