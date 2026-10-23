/**
 * Value types shared by the model catalog, the Host model store, and the
 * Models pane.
 *
 * They are declaration-only so the Client face can describe catalog and state
 * without importing the Host downloader, the filesystem, or any engine.
 * @module @deepseek-ai/dsh-voice-alive/models/types
 */

/** Catalog entries the voice layer knows how to install and run. */
export type ModelId = 'whisper-base' | 'parakeet-v3' | 'kokoro'

/** Role a catalog entry fills; the voice layer needs one ready entry per kind. */
export type ModelKind = 'asr' | 'tts'

/** Recognizer families the ASR engine understands; the engine never substitutes one. */
export type AsrCatalogEngine = 'whisper' | 'parakeet'

/** Runtime that loads a catalog entry's weights. */
export type ModelEngine = AsrCatalogEngine | 'kokoro'

/** Observable installation state of one catalog entry. */
export type ModelState = 'absent' | 'downloading' | 'verifying' | 'ready' | 'error'

/**
 * Stable failure category. Download, install, and readiness failures share one
 * union so a pane row and the readiness banner can name the same cause.
 */
export type ModelFailureCode =
  | 'network'
  | 'disk'
  | 'hash-mismatch'
  | 'size-mismatch'
  | 'unsupported-platform'
  | 'cancelled'
  | 'unknown-model'
  | 'state'
  | 'asr-missing'
  | 'tts-missing'
  | 'active-model-missing'
  | 'internal'

/** One typed failure, safe to hand to the pane. */
export interface ModelFailure {
  /** Stable category the pane maps to localized copy. */
  readonly code: ModelFailureCode
  /** Actionable description naming the model and the failed step. */
  readonly message: string
}

/**
 * One pinned weight file.
 *
 * `path` is relative to the model directory and is exactly the name the engine
 * looks for; `url` is revision-pinned so a moved upstream branch cannot change
 * the bytes after release.
 */
export interface ModelFile {
  /** Path inside the model directory, e.g. `onnx/model_quantized.onnx`. */
  readonly path: string
  /** Absolute https URL of the pinned revision. */
  readonly url: string
  /** Exact expected byte count. */
  readonly bytes: number
  /** Lowercase hex SHA-256 of the complete file. */
  readonly sha256: string
}

/** One installable model: what it is, what it costs, and where its bytes come from. */
export interface ModelRecord {
  /** Stable id used by the UI, the store, and the on-disk directory name. */
  readonly id: ModelId
  /** Whether the entry is a recognizer or a synthesizer. */
  readonly kind: ModelKind
  /** Engine that loads the directory, mapping to the ASR model id or Kokoro. */
  readonly engine: ModelEngine
  /** Product name shown in the Models pane. */
  readonly name: string
  /** One-line description of what the entry does. */
  readonly summary: string
  /** Languages the model handles, as the upstream model defines them. */
  readonly languages: readonly string[]
  /** Whether this is the recommended or required entry for its kind. */
  readonly required: boolean
  /** SPDX-style license identifier of the upstream weights. */
  readonly license: string
  /** Upstream model and conversion repository the pinned files come from. */
  readonly attribution: string
  /** Every file the engine needs, in install order. */
  readonly files: readonly ModelFile[]
}

/** Pane-facing snapshot of one catalog entry and its installation state. */
export interface ModelView {
  /** Catalog entry this view describes. */
  readonly id: ModelId
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
  readonly state: ModelState
  /** Bytes already present, including verified files kept for resume. */
  readonly receivedBytes: number
  /** Last failure, retained until the next attempt; null while healthy. */
  readonly failure: ModelFailure | null
}

/** Readiness once Kokoro and one recognizer are verified present on a supported host. */
export interface ModelReady {
  /** Always true; selects the ready variant. */
  readonly ready: true
  /** Recognizer satisfying the required set. */
  readonly asr: ModelId
  /** Kokoro satisfying the required set. */
  readonly tts: ModelId
  /** Always null; a ready store carries no failure. */
  readonly failure: null
}

/** Readiness while the required set is incomplete or the host is unsupported. */
export interface ModelBlocked {
  /** Always false; selects the blocked variant. */
  readonly ready: false
  /** Active or default recognizer already satisfying the set, or null. */
  readonly asr: ModelId | null
  /** Active or default Kokoro already satisfying the set, or null. */
  readonly tts: ModelId | null
  /** Why the voice layer is blocked. */
  readonly failure: ModelFailure
}

/** Whether the voice layer may run, and which entries satisfy it. */
export type ModelReadiness = ModelReady | ModelBlocked

/** One complete pane snapshot: every catalog row and the required-set readiness. */
export interface ModelSnapshot {
  /** Every catalog entry, in catalog order. */
  readonly rows: readonly ModelView[]
  /** Whether the required set is verified, and which entries satisfy it. */
  readonly readiness: ModelReadiness
}

/**
 * Verified model directories handed to the supervisor's `configure`.
 *
 * Structurally the engine supervisor's `ModelSelection`, declared here because
 * the Client face cannot import the engine.
 */
export interface ModelSelection {
  /** Recognizer and its verified directory, or null when no recognizer is ready. */
  readonly asr: { readonly id: AsrCatalogEngine; readonly directory: string } | null
  /** Kokoro directory and optional default voice, or null when Kokoro is not ready. */
  readonly tts: { readonly directory: string; readonly voice?: string } | null
}
