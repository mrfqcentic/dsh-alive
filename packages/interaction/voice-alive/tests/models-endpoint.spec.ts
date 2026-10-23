/** Host model routes: snapshot, action dispatch, and the event stream the shell forwards. */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { expect, it, vi } from 'vitest'
import {
  MODELS_ACTION_PATH,
  MODELS_EVENTS_PATH,
  MODELS_SNAPSHOT_PATH,
  modelSnapshot,
  registerModelRoutes,
} from '../src/models/host/endpoint.ts'
import { ModelStoreError } from '../src/models/host/errors.ts'
import type { ModelStore } from '../src/models/host/store.ts'
import type { ModelReadiness, ModelView } from '../src/models/types.ts'

const READY: ModelReadiness = { ready: true, asr: 'whisper-base', tts: 'kokoro', failure: null }

/** @param overrides - row fields to replace. @returns one catalog row. */
function row(overrides: Partial<ModelView> = {}): ModelView {
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

/** Recording model store the routes read. */
interface FakeStore extends ModelStore {
  /** @param next - rows the next read returns. */
  setViews(next: readonly ModelView[]): void
  /** @param readiness - readiness the next read reports. */
  setReadiness(next: ModelReadiness): void
  /** @returns how many subscriptions are live. */
  watchers(): number
  /** @returns the live listener callbacks, so a test can deliver a late change. */
  capture(): Array<(views: readonly ModelView[]) => void>
}

/**
 * Build the fake store.
 * @param overrides - store methods to replace.
 * @returns the store with its inspection helpers.
 */
function fakeStore(overrides: Partial<ModelStore> = {}): FakeStore {
  const listeners = new Set<(views: readonly ModelView[]) => void>()
  let views: readonly ModelView[] = [row()]
  let readiness: ModelReadiness = READY
  const store: FakeStore = {
    root: '/models',
    supported: true,
    list: () => views,
    status: () => views[0] ?? row(),
    subscribe(listener) {
      listeners.add(listener)
      listener(views)
      return () => { listeners.delete(listener) }
    },
    initialize: async () => {},
    download: async () => {},
    cancel: () => {},
    remove: async () => {},
    activate: () => {},
    readiness: () => readiness,
    selection: () => null,
    setViews(next) {
      views = next
      for (const listener of [...listeners]) listener(views)
    },
    setReadiness(next) { readiness = next },
    watchers: () => listeners.size,
    capture: () => [...listeners],
    ...overrides,
  }
  return store
}

/** Recording Connection route registry. */
interface FakeConnection {
  readonly routes: ConnectionFetchRoute[]
  readonly register: (route: ConnectionFetchRoute) => () => Promise<void>
}

/** @returns a registry that records each route and its withdrawal. */
function fakeConnection(): FakeConnection {
  const routes: ConnectionFetchRoute[] = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return async () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/**
 * @param connection - recording registry.
 * @param path - route to select.
 * @returns the registered route.
 */
function routeAt(connection: FakeConnection, path: string): ConnectionFetchRoute {
  const route = connection.routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route registered at ${path}`)
  return route
}

/** @param body - JSON response value. @returns request with that JSON body. */
function post(body: unknown): Request {
  return new Request(`http://127.0.0.1${MODELS_ACTION_PATH}`, { method: 'POST', body: JSON.stringify(body) })
}

it('registers the snapshot, event, and action routes and withdraws them', async () => {
  const connection = fakeConnection()
  const disposers = registerModelRoutes(connection, () => fakeStore())

  expect(connection.routes.map(route => route.path)).toEqual([
    MODELS_SNAPSHOT_PATH,
    MODELS_EVENTS_PATH,
    MODELS_ACTION_PATH,
  ])
  expect(routeAt(connection, MODELS_SNAPSHOT_PATH).methods).toEqual(['GET'])
  expect(routeAt(connection, MODELS_EVENTS_PATH).methods).toEqual(['GET'])
  expect(routeAt(connection, MODELS_ACTION_PATH).methods).toEqual(['POST'])
  expect(connection.routes.every(route => route.requestBody === 'buffered')).toBe(true)

  for (const dispose of disposers) await dispose()
  expect(connection.routes).toHaveLength(0)
})

it('builds one snapshot from the rows and readiness', () => {
  const store = fakeStore()
  expect(modelSnapshot(store)).toEqual({ rows: [row()], readiness: READY })
})

it('answers the snapshot route with the catalog and starts verification', async () => {
  const initialize = vi.fn(async () => {})
  const store = fakeStore({ initialize })
  const connection = fakeConnection()
  registerModelRoutes(connection, () => store)

  const response = await routeAt(connection, MODELS_SNAPSHOT_PATH).fetch(
    new Request(`http://127.0.0.1${MODELS_SNAPSHOT_PATH}`),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  await expect(response.json()).resolves.toEqual({ rows: [row()], readiness: READY })
  expect(initialize).toHaveBeenCalledOnce()
  expect(store.watchers()).toBe(0)
})

it('keeps the snapshot when verification rejects', async () => {
  const store = fakeStore({ initialize: async () => { throw new Error('hash failed') } })
  const connection = fakeConnection()
  registerModelRoutes(connection, () => store)

  const response = await routeAt(connection, MODELS_SNAPSHOT_PATH).fetch(
    new Request(`http://127.0.0.1${MODELS_SNAPSHOT_PATH}`),
  )

  expect(response.status).toBe(200)
  await response.body?.cancel()
})

it('answers 503 with the typed failure when the profile has no store', async () => {
  const missing = (): ModelStore => {
    throw new ModelStoreError('state', 'the voice model store needs a dsh profile')
  }
  const connection = fakeConnection()
  registerModelRoutes(connection, missing)

  for (const path of [MODELS_SNAPSHOT_PATH, MODELS_EVENTS_PATH]) {
    const response = await routeAt(connection, path).fetch(new Request(`http://127.0.0.1${path}`))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      failure: { code: 'state', message: 'the voice model store needs a dsh profile' },
    })
  }
  const action = await routeAt(connection, MODELS_ACTION_PATH).fetch(post({ action: 'download', id: 'kokoro' }))
  expect(action.status).toBe(503)
  await action.body?.cancel()
})

it('forwards download and cancel without waiting for the download', async () => {
  const download = vi.fn(() => new Promise<void>(() => {}))
  const cancel = vi.fn()
  const connection = fakeConnection()
  registerModelRoutes(connection, () => fakeStore({ download, cancel }))

  const started = await routeAt(connection, MODELS_ACTION_PATH).fetch(post({ action: 'download', id: 'kokoro' }))
  expect(started.status).toBe(200)
  await expect(started.json()).resolves.toEqual({ ok: true })
  expect(download).toHaveBeenCalledWith('kokoro')

  const stopped = await routeAt(connection, MODELS_ACTION_PATH).fetch(post({ action: 'cancel', id: 'kokoro' }))
  await expect(stopped.json()).resolves.toEqual({ ok: true })
  expect(cancel).toHaveBeenCalledWith('kokoro')
})

it('acknowledges a download whose later failure reaches the pane as state', async () => {
  const download = vi.fn(async () => { throw new ModelStoreError('network', 'the download failed') })
  const connection = fakeConnection()
  registerModelRoutes(connection, () => fakeStore({ download }))

  const response = await routeAt(connection, MODELS_ACTION_PATH).fetch(post({ action: 'download', id: 'whisper-base' }))
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true })
})

it('activates one entry and awaits removal', async () => {
  const activate = vi.fn()
  const remove = vi.fn(async () => {})
  const connection = fakeConnection()
  registerModelRoutes(connection, () => fakeStore({ activate, remove }))

  await routeAt(connection, MODELS_ACTION_PATH).fetch(post({ action: 'activate', id: 'parakeet-v3' }))
  expect(activate).toHaveBeenCalledWith('parakeet-v3')

  const removed = await routeAt(connection, MODELS_ACTION_PATH).fetch(post({ action: 'remove', id: 'kokoro' }))
  await expect(removed.json()).resolves.toEqual({ ok: true })
  expect(remove).toHaveBeenCalledWith('kokoro')
})

it('reports a refused action with its typed failure', async () => {
  const remove = vi.fn(async () => { throw new ModelStoreError('disk', 'the disk rejected the removal') })
  const connection = fakeConnection()
  registerModelRoutes(connection, () => fakeStore({ remove }))

  const response = await routeAt(connection, MODELS_ACTION_PATH).fetch(post({ action: 'remove', id: 'kokoro' }))

  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toEqual({
    ok: false,
    failure: { code: 'disk', message: 'the disk rejected the removal' },
  })
})

it('rejects a body that is not JSON and a body that is not an action', async () => {
  const connection = fakeConnection()
  registerModelRoutes(connection, () => fakeStore())

  const notJson = await routeAt(connection, MODELS_ACTION_PATH).fetch(
    new Request(`http://127.0.0.1${MODELS_ACTION_PATH}`, { method: 'POST', body: 'not json' }),
  )
  expect(notJson.status).toBe(400)
  const notJsonBody: unknown = await notJson.json()
  expect(notJsonBody).toMatchObject({ ok: false, failure: { code: 'state' } })
  expect((notJsonBody as { failure: { message: string } }).failure.message).toContain('is not JSON')

  for (const body of [null, [], { action: 'delete', id: 'kokoro' }, { action: 'download' }]) {
    const response = await routeAt(connection, MODELS_ACTION_PATH).fetch(post(body))
    expect(response.status).toBe(400)
    const payload: unknown = await response.json()
    expect(payload).toMatchObject({ ok: false })
  }
})

it('rejects an action naming no catalog entry', async () => {
  const connection = fakeConnection()
  registerModelRoutes(connection, () => fakeStore())

  const response = await routeAt(connection, MODELS_ACTION_PATH).fetch(post({ action: 'download', id: 'whisper-99' }))

  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toEqual({
    ok: false,
    failure: { code: 'unknown-model', message: 'the model catalog has no entry named whisper-99' },
  })
})

it('streams one frame on open and one per store change', async () => {
  const store = fakeStore()
  const connection = fakeConnection()
  registerModelRoutes(connection, () => store)
  const abort = new AbortController()
  const response = await routeAt(connection, MODELS_EVENTS_PATH).fetch(
    new Request(`http://127.0.0.1${MODELS_EVENTS_PATH}`, { signal: abort.signal }),
  )
  expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()

  const open = await reader.read()
  expect(open.done).toBe(false)
  expect(JSON.parse(decoder.decode(open.value).replace('data: ', '').trim()))
    .toEqual({ rows: [row()], readiness: READY })
  expect(store.watchers()).toBe(1)

  store.setViews([row({ state: 'downloading', receivedBytes: 10 })])
  const change = await reader.read()
  if (change.value === undefined) throw new Error('the store change produced no frame')
  expect(JSON.parse(decoder.decode(change.value).replace('data: ', '').trim()))
    .toMatchObject({ rows: [{ state: 'downloading', receivedBytes: 10 }] })

  const late = store.capture()
  abort.abort()
  await expect(reader.read()).resolves.toMatchObject({ done: true })
  expect(store.watchers()).toBe(0)

  // A change that lands after the stream closed must not write into the closed body.
  for (const listener of late) listener([row({ state: 'ready' })])
})

it('releases the subscription when the shell cancels the stream', async () => {
  const store = fakeStore()
  const connection = fakeConnection()
  registerModelRoutes(connection, () => store)
  const response = await routeAt(connection, MODELS_EVENTS_PATH).fetch(
    new Request(`http://127.0.0.1${MODELS_EVENTS_PATH}`),
  )
  const reader = response.body!.getReader()
  await reader.read()
  expect(store.watchers()).toBe(1)

  await reader.cancel()

  expect(store.watchers()).toBe(0)
})

it('closes an event stream whose request was already aborted', async () => {
  const store = fakeStore()
  const connection = fakeConnection()
  registerModelRoutes(connection, () => store)
  const abort = new AbortController()
  abort.abort()

  const response = await routeAt(connection, MODELS_EVENTS_PATH).fetch(
    new Request(`http://127.0.0.1${MODELS_EVENTS_PATH}`, { signal: abort.signal }),
  )
  const reader = response.body!.getReader()

  expect(store.watchers()).toBe(0)
  await reader.cancel()
})
