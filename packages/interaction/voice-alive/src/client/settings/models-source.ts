/**
 * Model catalog data seat for the Models pane.
 *
 * The pane renders {@link ModelCatalogSource}; the shell's preload owns the
 * `window.dshVoiceModels` bridge. The shell forwards every read and action to
 * the Host model routes and pushes each store change, so the pane never polls
 * and holds no state the Host did not report.
 *
 * The bridge payload crosses a process boundary, so it is validated here and a
 * malformed frame is dropped rather than rendered. A bridge that answers no
 * store is reported as unsupported, which keeps the pane's disconnected state
 * honest instead of showing an empty catalog as if the Host had none.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/models-source
 */
import type { ModelKind } from '../../models/types.ts'

/** Installation state a row can show; the host and this pane share the five values. */
export type ModelRowState = 'absent' | 'downloading' | 'verifying' | 'ready' | 'error'

/** One typed failure, reduced to what a row renders. */
export interface ModelRowFailure {
  /** Stable category; unknown codes fall back to a generic error label. */
  readonly code: string
  /** Actionable description. */
  readonly message: string
}

/** One catalog row as the pane renders it. */
export interface ModelRowView {
  /** Stable catalog id. */
  readonly id: string
  /** Recognizer or synthesizer. */
  readonly kind: ModelKind
  /** Product name. */
  readonly name: string
  /** One-line description. */
  readonly summary: string
  /** Languages the model handles. */
  readonly languages: readonly string[]
  /** Whether the entry is required for its kind. */
  readonly required: boolean
  /** Byte count of every pinned file. */
  readonly bytes: number
  /** Current installation state. */
  readonly state: ModelRowState
  /** Bytes already present. */
  readonly receivedBytes: number
  /** Last failure, or null while healthy. */
  readonly failure: ModelRowFailure | null
}

/** Whether the voice layer may run, and which entries satisfy the required set. */
export interface ModelReadinessView {
  /** True only when the required set is verified. */
  readonly ready: boolean
  /** The active or default recognizer, or null when none is ready. */
  readonly asr: string | null
  /** The active or default synthesizer, or null when none is ready. */
  readonly tts: string | null
  /** Why the voice layer is blocked, or null when it is ready. */
  readonly failure: ModelRowFailure | null
}

/** One complete pane snapshot pushed by the Host. */
export interface ModelSnapshot {
  /** Every catalog row, in catalog order. */
  readonly rows: readonly ModelRowView[]
  /** Required-set readiness. */
  readonly readiness: ModelReadinessView
}

/** Methods the shell preload exposes on `window.dshVoiceModels`. */
export interface VoiceModelsBridgeApi {
  /** Bridge protocol version the shell implements. */
  readonly protocolVersion?: number
  /**
   * Read the current rows and readiness.
   * @returns the snapshot, or null when the Host serves no model store.
   */
  state?(): Promise<ModelSnapshot | null>
  /** @param listener - receives every pushed snapshot. @returns function that stops observing. */
  subscribe?(listener: (snapshot: ModelSnapshot) => void): () => void
  /** @param id - catalog entry to download. @returns completion of the request. */
  download?(id: string): Promise<void>
  /** @param id - catalog entry whose download should stop. @returns completion of the request. */
  cancel?(id: string): Promise<void>
  /** @param id - catalog entry to remove. @returns completion of the request. */
  remove?(id: string): Promise<void>
  /** @param id - ready catalog entry readiness should use for its kind. @returns completion of the request. */
  activate?(id: string): Promise<void>
}

declare global {
  interface Window {
    /** Preload bridge installed by the Desktop shell; absent in a browser tab. */
    dshVoiceModels?: VoiceModelsBridgeApi
  }
}

/** Protocol version this pane understands. */
export const MODELS_PROTOCOL_VERSION = 1

/** Snapshot shown before the Host answered, whenever no bridge exists, and after it reported none. */
const EMPTY_SNAPSHOT: ModelSnapshot = Object.freeze({
  rows: Object.freeze([]),
  readiness: Object.freeze({ ready: false, asr: null, tts: null, failure: null }),
})

/** Marker distinguishing a malformed field from a legitimately absent one. */
const INVALID = Symbol('invalid')

/** A validated value, or the marker that the input was malformed. */
type Parsed<T> = T | typeof INVALID

/** @param value - decoded bridge value. @returns whether it is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param value - decoded state field. @returns whether it is one of the five row states. */
function isRowState(value: unknown): value is ModelRowState {
  return value === 'absent' || value === 'downloading' || value === 'verifying' || value === 'ready' || value === 'error'
}

/** @param value - decoded catalog id field. @returns whether it is an id or an explicit absence. */
function isIdOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * Validate one failure field.
 * @param value - decoded `failure` value; `null` means healthy.
 * @returns the failure, null, or {@link INVALID}.
 */
function parseFailure(value: unknown): Parsed<ModelRowFailure | null> {
  if (value === null) return null
  if (!isRecord(value)) return INVALID
  if (typeof value.code !== 'string' || typeof value.message !== 'string') return INVALID
  return { code: value.code, message: value.message }
}

/**
 * Validate one row.
 * @param value - decoded row value.
 * @returns the row, or null when any field is missing or mistyped.
 */
function parseRow(value: unknown): ModelRowView | null {
  if (!isRecord(value)) return null
  const { id, kind, name, summary, required, bytes, state, receivedBytes } = value
  if (typeof id !== 'string' || typeof name !== 'string' || typeof summary !== 'string') return null
  if (kind !== 'asr' && kind !== 'tts') return null
  if (typeof required !== 'boolean' || typeof bytes !== 'number' || typeof receivedBytes !== 'number') return null
  if (!isRowState(state)) return null
  if (!Array.isArray(value.languages)) return null
  const languages: string[] = []
  for (const language of value.languages) {
    if (typeof language !== 'string') return null
    languages.push(language)
  }
  const failure = parseFailure(value.failure)
  if (failure === INVALID) return null
  return { id, kind, name, summary, languages, required, bytes, state, receivedBytes, failure }
}

/**
 * Validate one bridge snapshot.
 * @param value - decoded bridge value.
 * @returns the snapshot, or null when the payload is malformed.
 */
export function parseSnapshot(value: unknown): ModelSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.rows) || !isRecord(value.readiness)) return null
  const rows: ModelRowView[] = []
  for (const raw of value.rows) {
    const row = parseRow(raw)
    if (row === null) return null
    rows.push(row)
  }
  const ready = value.readiness.ready
  if (typeof ready !== 'boolean') return null
  const asr = value.readiness.asr
  const tts = value.readiness.tts
  if (!isIdOrNull(asr) || !isIdOrNull(tts)) return null
  const failure = parseFailure(value.readiness.failure)
  if (failure === INVALID) return null
  return { rows, readiness: { ready, asr, tts, failure } }
}

/** Read and act on the model catalog the Host serves. */
export interface ModelCatalogSource {
  /** Whether the shell bridge reaches a Host that serves the model store. */
  readonly supported: boolean
  /** @returns the latest snapshot; the empty snapshot before the Host answered. */
  snapshot(): ModelSnapshot
  /** @param listener - called after every snapshot change. @returns function that stops observing. */
  subscribe(listener: () => void): () => void
  /** @param id - catalog entry to download. @returns completion of the request. */
  download(id: string): Promise<void>
  /** @param id - catalog entry whose download should stop. */
  cancel(id: string): void
  /** @param id - catalog entry to remove. @returns completion of the request. */
  remove(id: string): Promise<void>
  /** @param id - ready catalog entry readiness should use for its kind. @returns completion of the request. */
  activate(id: string): Promise<void>
}

/**
 * Build the catalog source over one shell API reader.
 *
 * The first subscriber asks the Host for its current state; later snapshots
 * arrive through the bridge subscription, and the subscription is released
 * with the last subscriber. A rejected or empty answer means the Host serves
 * no store, so the pane renders its disconnected state instead of an empty
 * catalog. A rejected action is dropped for the same reason: the Host pushes
 * every row failure as state, and this seat has no second error surface.
 * @param read - returns the current API, normally from `window`.
 * @returns the source the Models pane renders.
 */
export function createModelCatalogSource(
  read: () => VoiceModelsBridgeApi | undefined = () => window.dshVoiceModels,
): ModelCatalogSource {
  const listeners = new Set<() => void>()
  let snapshot = EMPTY_SNAPSHOT
  let absent = false
  let detach: (() => void) | undefined
  let requested = false

  const current = (): VoiceModelsBridgeApi | undefined => {
    const candidate = read()
    return candidate?.protocolVersion === MODELS_PROTOCOL_VERSION ? candidate : undefined
  }

  const publish = (next: ModelSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const missing = (): void => {
    absent = true
    publish(EMPTY_SNAPSHOT)
  }

  const accept = (value: unknown): void => {
    const parsed = parseSnapshot(value)
    if (parsed === null) return
    absent = false
    publish(parsed)
  }

  const request = (api: VoiceModelsBridgeApi): void => {
    if (requested) return
    requested = true
    if (typeof api.state !== 'function') return
    void api.state().then((value) => {
      if (value === null) {
        missing()
        return
      }
      const parsed = parseSnapshot(value)
      if (parsed === null) missing()
      else accept(parsed)
    }, () => {
      // The Host route is gone: report it the same way as a Host that serves no store.
      missing()
    })
  }

  const send = (
    api: VoiceModelsBridgeApi | undefined,
    action: 'download' | 'remove' | 'activate',
    id: string,
  ): Promise<void> => {
    if (api === undefined) return Promise.resolve()
    const method = api[action]
    if (method === undefined) return Promise.resolve()
    return method.call(api, id).catch(() => {
      // The Host pushes every row failure as state; a closed channel has no second surface.
    })
  }

  return {
    get supported() { return !absent && current() !== undefined },
    snapshot() { return snapshot },
    subscribe(listener) {
      listeners.add(listener)
      const api = current()
      if (api === undefined) return () => { listeners.delete(listener) }
      request(api)
      if (listeners.size === 1 && typeof api.subscribe === 'function') {
        detach = api.subscribe(accept)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        detach?.()
        detach = undefined
        requested = false
        absent = false
      }
    },
    download(id) {
      return send(current(), 'download', id)
    },
    cancel(id) {
      const api = current()
      if (typeof api?.cancel !== 'function') return
      void api.cancel.call(api, id).catch(() => {
        // The Host pushes every row failure as state; a closed channel has no second surface.
      })
    },
    remove(id) {
      return send(current(), 'remove', id)
    },
    activate(id) {
      return send(current(), 'activate', id)
    },
  }
}

/** Source shared by the Models pane. */
export const modelCatalogSource: ModelCatalogSource = createModelCatalogSource()
