/**
 * Exact Connection Fetch routes the Desktop shell forwards the Models pane to.
 *
 * The panel document is served from the shell origin, where the client runtime
 * has no authenticated carrier to the Host. The shell therefore holds the
 * bridge: it calls these routes with the browser cookie it already owns and
 * pushes each frame to the pane over IPC. The routes are the Host half of that
 * bridge, so the store stays the only place model state is decided.
 *
 * Every route answers JSON except the event stream, which emits one snapshot
 * per store change. Only the owner Peer reaches an exact route, so these
 * requests are the shell's own and never a remote client's.
 * @module @deepseek-ai/dsh-voice-alive/models/host/endpoint
 */
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { MODEL_CATALOG } from '../catalog.ts'
import type { ModelFailureCode, ModelId, ModelSnapshot } from '../types.ts'
import { failureOf, reasonOf } from './errors.ts'
import type { ModelStore } from './store.ts'

/** Route returning the current rows and readiness. */
export const MODELS_SNAPSHOT_PATH = '/api/voice.models'
/** Route streaming one snapshot per store change. */
export const MODELS_EVENTS_PATH = '/api/voice.models.events'
/** Route accepting one catalog action. */
export const MODELS_ACTION_PATH = '/api/voice.models.action'

/** Catalogs a pane can act on; the wire values are stable. */
export type ModelActionKind = 'download' | 'cancel' | 'remove' | 'activate'

/** Action names this route accepts, in the order the dispatch reads them. */
const ACTION_KINDS: readonly ModelActionKind[] = ['download', 'cancel', 'remove', 'activate']

/** One decoded action request. */
interface ModelActionRequest {
  readonly action: ModelActionKind
  readonly id: ModelId
}

/** JSON headers shared by every response that carries a value or a failure. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

/** Event-stream headers; the bridge forwards chunks as they arrive. */
const EVENT_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
} as const

/**
 * @param body - JSON-serializable response value.
 * @param status - HTTP status.
 * @returns one JSON response.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/**
 * @param error - rejection from a store call.
 * @param status - HTTP status that classifies the refusal.
 * @returns the typed failure the pane shows, never the cause or stack.
 */
function failureResponse(error: unknown, status: number): Response {
  return jsonResponse({ ok: false, failure: failureOf(error) }, status)
}

/**
 * @param code - stable failure category.
 * @param message - actionable description.
 * @param status - HTTP status that classifies the refusal.
 * @returns the typed failure the pane shows.
 */
function rejection(code: ModelFailureCode, message: string, status: number): Response {
  return jsonResponse({ ok: false, failure: { code, message } }, status)
}

/**
 * Pane-facing snapshot of the store.
 * @param store - profile model store.
 * @returns every catalog row in catalog order plus the required-set readiness.
 */
export function modelSnapshot(store: ModelStore): ModelSnapshot {
  return { rows: store.list(), readiness: store.readiness() }
}

/**
 * Verify the directories an earlier process left on disk.
 *
 * The first snapshot starts the store's one shared verification; each entry
 * publishes `verifying` and then its result through the subscription, so the
 * pane sees the work instead of waiting on this response.
 * @param store - profile model store.
 */
function startVerification(store: ModelStore): void {
  void store.initialize().catch(() => {
    // Per-entry failures publish an `error` row; nothing else can observe this
    // response, and the next snapshot request retries the shared promise.
  })
}

/**
 * Decode one action request body.
 * @param value - parsed JSON body.
 * @returns the request, or the refusal to answer with when the body is malformed.
 */
function decodeAction(value: unknown): { readonly request: ModelActionRequest } | { readonly refusal: Response } {
  const malformed = rejection('state', 'the model action body is not an action request', 400)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { refusal: malformed }
  const { action, id } = value as Record<string, unknown>
  if (typeof action !== 'string' || !ACTION_KINDS.includes(action as ModelActionKind)) return { refusal: malformed }
  if (typeof id !== 'string') return { refusal: malformed }
  const record = MODEL_CATALOG.find(entry => entry.id === id)
  if (record === undefined) {
    return { refusal: rejection('unknown-model', `the model catalog has no entry named ${id}`, 400) }
  }
  return { request: { action: action as ModelActionKind, id: record.id } }
}

/**
 * Apply one decoded action to the store.
 *
 * A download outlives this response: its progress and its failure are row
 * states the subscription already carries, so the request only acknowledges the
 * accepted action. Remove is awaited because it settles from disk rather than
 * from a published state.
 * @param store - profile model store.
 * @param request - decoded action.
 * @returns settlement once the action was accepted.
 */
async function applyAction(store: ModelStore, request: ModelActionRequest): Promise<void> {
  switch (request.action) {
    case 'download':
      void store.download(request.id).catch(() => {
        // The rejection is recorded on the row and pushed; this response is gone.
      })
      return
    case 'cancel':
      store.cancel(request.id)
      return
    case 'activate':
      store.activate(request.id)
      return
    case 'remove':
      await store.remove(request.id)
      return
  }
}

/**
 * Answer the snapshot route.
 * @param models - resolves the profile store; the thunk keeps it lazy.
 * @returns every row and the readiness, or a typed failure when the store is absent.
 */
function snapshotResponse(models: () => ModelStore): Response {
  let store: ModelStore
  try {
    store = models()
  } catch (error) {
    return failureResponse(error, 503)
  }
  startVerification(store)
  return jsonResponse(modelSnapshot(store))
}

/**
 * Answer the action route.
 * @param request - authenticated Fetch request whose body is the JSON action.
 * @param models - resolves the profile store.
 * @returns the acknowledgement, or a typed failure when the action was refused.
 */
async function actionResponse(request: Request, models: () => ModelStore): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    return rejection('state', `the model action body is not JSON (${reasonOf(error)})`, 400)
  }
  const decoded = decodeAction(body)
  if ('refusal' in decoded) return decoded.refusal
  const action = decoded.request
  let store: ModelStore
  try {
    store = models()
  } catch (error) {
    return failureResponse(error, 503)
  }
  try {
    await applyAction(store, action)
    return jsonResponse({ ok: true })
  } catch (error) {
    return failureResponse(error, 409)
  }
}

/**
 * Answer the event route with one server-sent snapshot per store change.
 *
 * The subscription opens with the current snapshot and closes with the
 * request, so a pane that stops watching stops the stream and the store work
 * behind it.
 * @param request - authenticated Fetch request; its signal aborts the stream.
 * @param models - resolves the profile store.
 * @returns the streaming response, or a typed failure when the store is absent.
 */
function eventResponse(request: Request, models: () => ModelStore): Response {
  let store: ModelStore
  try {
    store = models()
  } catch (error) {
    return failureResponse(error, 503)
  }
  const encoder = new TextEncoder()
  let detach: (() => void) | undefined
  let closed = false
  const stop = (): void => {
    if (closed) return
    closed = true
    detach?.()
    detach = undefined
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (): void => {
        if (closed) return
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(modelSnapshot(store))}\n\n`))
      }
      detach = store.subscribe(send)
      const abort = (): void => {
        stop()
        controller.close()
      }
      if (request.signal.aborted) {
        abort()
        return
      }
      request.signal.addEventListener('abort', abort, { once: true })
    },
    cancel() {
      stop()
    },
  })
  return new Response(body, { headers: EVENT_HEADERS })
}

/**
 * Register the three model routes on Connection.
 * @param connection - exact Fetch-route registry of the owning Host Context.
 * @param models - resolves the profile store, lazily.
 * @returns the disposers that withdraw the routes.
 */
export function registerModelRoutes(
  connection: HostConnectionFetch,
  models: () => ModelStore,
): readonly (() => Promise<void>)[] {
  return [
    connection.register({
      path: MODELS_SNAPSHOT_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(snapshotResponse(models)),
    }),
    connection.register({
      path: MODELS_EVENTS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => Promise.resolve(eventResponse(request, models)),
    }),
    connection.register({
      path: MODELS_ACTION_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => actionResponse(request, models),
    }),
  ]
}
