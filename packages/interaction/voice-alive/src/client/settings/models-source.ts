/**
 * Model catalog data seat for the Models pane.
 *
 * The pane renders {@link ModelCatalogSource}; the Host model store answers
 * through the Desktop shell's `window.dshVoiceModels` bridge. The shell ships
 * that bridge independently of this surface, so it is detected and version
 * checked on every read, and a browser tab without it renders the disconnected
 * state instead of pretending a model is installed.
 *
 * The bridge payload crosses a process boundary, so it is validated here and a
 * malformed frame is dropped rather than rendered.
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

/** Whether the voice layer may run. */
export interface ModelReadinessView {
  /** True only when the required set is verified. */
  readonly ready: boolean
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

/** Methods the Desktop preload exposes on `window.dshVoiceModels`. */
export interface VoiceModelsBridgeApi {
  /** Bridge protocol version the shell implements. */
  readonly protocolVersion?: number
  /** @returns the current rows and readiness. */
  state?(): Promise<ModelSnapshot>
  /** @param listener - receives every pushed snapshot. @returns function that stops observing. */
  subscribe?(listener: (snapshot: ModelSnapshot) => void): () => void
  /** @param id - catalog entry to download. @returns completion of the request. */
  download?(id: string): Promise<void>
  /** @param id - catalog entry whose download should stop. @returns completion of the request. */
  cancel?(id: string): Promise<void>
  /** @param id - catalog entry to remove. @returns completion of the request. */
  remove?(id: string): Promise<void>
}

declare global {
  interface Window {
    /** Preload bridge installed by the Desktop shell; absent in a browser tab. */
    dshVoiceModels?: VoiceModelsBridgeApi
  }
}

/** Protocol version this pane understands. */
export const MODELS_PROTOCOL_VERSION = 1

/** Snapshot shown before the Host answered, and whenever no bridge exists. */
const EMPTY_SNAPSHOT: ModelSnapshot = Object.freeze({
  rows: Object.freeze([]),
  readiness: Object.freeze({ ready: false, failure: null }),
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
  const failure = parseFailure(value.readiness.failure)
  if (failure === INVALID) return null
  return { rows, readiness: { ready, failure } }
}

/** Read and act on the model catalog the Host serves. */
export interface ModelCatalogSource {
  /** Whether the shell exposes a compatible bridge right now. */
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
}

/**
 * Build the catalog source over one shell API reader.
 *
 * The first subscriber asks the Host for its current state; later snapshots
 * arrive through the bridge subscription. A rejected request means the channel
 * is gone, so the pane keeps its last snapshot instead of surfacing a raw
 * channel error. Action rejections are dropped for the same reason: the Host
 * pushes every row failure as state.
 * @param read - returns the current API, normally from `window`.
 * @returns the source the Models pane renders.
 */
export function createModelCatalogSource(
  read: () => VoiceModelsBridgeApi | undefined = () => window.dshVoiceModels,
): ModelCatalogSource {
  const listeners = new Set<() => void>()
  let snapshot = EMPTY_SNAPSHOT
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

  const accept = (value: unknown): void => {
    const parsed = parseSnapshot(value)
    if (parsed !== null) publish(parsed)
  }

  const request = (api: VoiceModelsBridgeApi): void => {
    if (requested) return
    requested = true
    if (typeof api.state !== 'function') return
    void api.state().then(accept, () => {
      // The channel closed before it answered; the pane keeps rendering the empty snapshot.
    })
  }

  return {
    get supported() { return current() !== undefined },
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
      }
    },
    download(id) {
      const api = current()
      return typeof api?.download === 'function' ? api.download(id).catch(() => {}) : Promise.resolve()
    },
    cancel(id) {
      const api = current()
      if (typeof api?.cancel !== 'function') return
      void api.cancel(id).catch(() => {
        // The channel closed before the request arrived; the next snapshot reports the state.
      })
    },
    remove(id) {
      const api = current()
      return typeof api?.remove === 'function' ? api.remove(id).catch(() => {}) : Promise.resolve()
    },
  }
}

/** Source shared by the Models pane. */
export const modelCatalogSource: ModelCatalogSource = createModelCatalogSource()
