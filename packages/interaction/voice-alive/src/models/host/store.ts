/**
 * Host model store: catalog state, downloads, verification, readiness.
 *
 * The store owns the on-disk truth. A model is `ready` only after every pinned
 * file matched its byte count and SHA-256, either when the download finalized or
 * when {@link ModelStore.initialize} re-verified an existing directory at
 * startup. There is no fallback between models: {@link ModelStore.selection}
 * returns null while the required set is incomplete, so the voice layer cannot
 * start on a partial install.
 * @module @deepseek-ai/dsh-voice-alive/models/host/store
 */
import { MODEL_CATALOG, modelBytes } from '../catalog.ts'
import type {
  ModelFailure,
  ModelId,
  ModelKind,
  ModelReadiness,
  ModelRecord,
  ModelSelection,
  ModelState,
  ModelView,
} from '../types.ts'
import { downloadModel } from './download.ts'
import { ModelStoreError, diskStep, failureOf, reasonOf } from './errors.ts'
import { createNodeFileSystem, type ModelFileSystem } from './io.ts'
import { filePath, modelDirectory, stagingDirectory } from './layout.ts'
import { createFetchTransport, type ModelTransport } from './transport.ts'

/**
 * The only platform v1 ships for: sherpa-onnx and onnxruntime-node are pinned to
 * Apple Silicon, so another host is refused before any byte is fetched.
 */
export const SUPPORTED_PLATFORM = 'darwin-arm64'

/** One model's mutable installation state. */
interface Entry {
  readonly record: ModelRecord
  state: ModelState
  receivedBytes: number
  failure: ModelFailure | null
  /** Set while a download runs; aborts it. */
  controller: AbortController | undefined
  /** Settles when the current download finishes, successfully or not. */
  run: Promise<void> | undefined
  /** Chosen by the user for its kind; readiness prefers it over the default. */
  active: boolean
}

/** Construction options; production supplies only the root. */
export interface ModelStoreOptions {
  /** Directory that holds one child directory per installed model. */
  readonly root: string
  /** Platform identity; defaults to `${process.platform}-${process.arch}`. */
  readonly platform?: string
  /** Filesystem port; defaults to the Node adapter. */
  readonly fs?: ModelFileSystem
  /** HTTP port; defaults to the fetch adapter. */
  readonly transport?: ModelTransport
  /**
   * Pinned entries this store installs; defaults to {@link MODEL_CATALOG}.
   * A test supplies a small fixture set instead of the real weight sizes.
   */
  readonly catalog?: readonly ModelRecord[]
}

/** Catalog state, install operations, and readiness for the voice layer. */
export interface ModelStore {
  /** Directory that holds one child directory per installed model. */
  readonly root: string
  /** Whether this host can load the pinned runtimes at all. */
  readonly supported: boolean
  /**
   * Current view of every catalog entry, in catalog order.
   * @returns one immutable view per entry.
   */
  list(): readonly ModelView[]
  /**
   * Current view of one entry.
   * @param id - catalog entry to describe.
   * @returns the entry's view.
   * @throws {ModelStoreError} with `unknown-model` when the catalog has no such entry.
   */
  status(id: ModelId): ModelView
  /**
   * Observe state changes; the listener also receives the current state at subscribe.
   * @param listener - called with every snapshot.
   * @returns function that stops observing.
   */
  subscribe(listener: (views: readonly ModelView[]) => void): () => void
  /**
   * Verify every model directory already on disk. Idempotent; the first call's
   * promise is shared. A host that cannot run the pinned runtimes verifies
   * nothing and reports it through {@link ModelStore.readiness}.
   * @returns settlement once every present directory was hashed.
   */
  initialize(): Promise<void>
  /**
   * Download, verify, and finalize one entry.
   * @param id - catalog entry to install.
   * @returns settlement once the directory is ready.
   * @throws {ModelStoreError} for a refused platform, an already-installed
   * entry, a concurrent download, or a typed download failure.
   */
  download(id: ModelId): Promise<void>
  /**
   * Abort a running download. The partial payload is discarded and the entry
   * returns to `absent` once the download settles.
   * @param id - catalog entry whose download should stop.
   */
  cancel(id: ModelId): void
  /**
   * Delete an entry's weights and partial payload.
   * @param id - catalog entry to remove.
   * @returns settlement once the directories are gone.
   */
  remove(id: ModelId): Promise<void>
  /**
   * Choose the entry readiness should use for its kind.
   * @param id - catalog entry to activate.
   */
  activate(id: ModelId): void
  /** Whether the required set is verified, and which entries satisfy it. */
  readiness(): ModelReadiness
  /**
   * Verified selection the engine supervisor configures.
   * @returns the selection, or null while the required set is incomplete.
   */
  selection(): ModelSelection | null
}

/**
 * Build the pane view of one entry.
 * @param entry - mutable store entry.
 * @returns an immutable snapshot.
 */
function viewOf(entry: Entry): ModelView {
  const record = entry.record
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    summary: record.summary,
    languages: [...record.languages],
    required: record.required,
    bytes: modelBytes(record),
    state: entry.state,
    receivedBytes: entry.receivedBytes,
    failure: entry.failure === null ? null : { ...entry.failure },
  }
}

/**
 * Create one model store.
 * @param options - root directory and optional ports.
 * @returns a store whose entries start absent.
 */
export function createModelStore(options: ModelStoreOptions): ModelStore {
  return new ModelStoreImpl(options)
}

/** Mutable store implementation kept behind the interface seam. */
class ModelStoreImpl implements ModelStore {
  readonly root: string
  readonly supported: boolean
  private readonly fs: ModelFileSystem
  private readonly transport: ModelTransport
  private readonly entries = new Map<ModelId, Entry>()
  private readonly catalog: readonly ModelRecord[]
  private readonly listeners = new Set<(views: readonly ModelView[]) => void>()
  private initializing: Promise<void> | undefined

  constructor(options: ModelStoreOptions) {
    this.root = options.root
    this.supported = (options.platform ?? `${process.platform}-${process.arch}`) === SUPPORTED_PLATFORM
    this.fs = options.fs ?? createNodeFileSystem()
    this.transport = options.transport ?? createFetchTransport()
    this.catalog = options.catalog ?? MODEL_CATALOG
    for (const record of this.catalog) {
      this.entries.set(record.id, {
        record,
        state: 'absent',
        receivedBytes: 0,
        failure: null,
        controller: undefined,
        run: undefined,
        active: false,
      })
    }
  }

  list(): readonly ModelView[] {
    return [...this.entries.values()].map(viewOf)
  }

  status(id: ModelId): ModelView {
    return viewOf(this.entry(id))
  }

  subscribe(listener: (views: readonly ModelView[]) => void): () => void {
    this.listeners.add(listener)
    listener(this.list())
    return () => { this.listeners.delete(listener) }
  }

  initialize(): Promise<void> {
    this.initializing ??= this.verifyPresent()
    return this.initializing
  }

  async download(id: ModelId): Promise<void> {
    const entry = this.entry(id)
    if (!this.supported) {
      throw new ModelStoreError('unsupported-platform',
        `model downloads require ${SUPPORTED_PLATFORM}; this host reports another platform`)
    }
    if (entry.run !== undefined) {
      throw new ModelStoreError('state', `${entry.record.name} is already downloading`)
    }
    await this.initialize()
    if (entry.state === 'ready') {
      throw new ModelStoreError('state', `${entry.record.name} is already installed; remove it to download again`)
    }
    const controller = new AbortController()
    entry.controller = controller
    entry.state = 'downloading'
    entry.receivedBytes = 0
    entry.failure = null
    this.notify()
    const run = this.runDownload(entry, controller)
    entry.run = run.then(() => undefined, () => undefined)
    return run
  }

  cancel(id: ModelId): void {
    this.entry(id).controller?.abort()
  }

  async remove(id: ModelId): Promise<void> {
    const entry = this.entry(id)
    entry.controller?.abort()
    await entry.run
    await diskStep(this.fs.remove(modelDirectory(this.root, id)), `remove the ${entry.record.name} weights`)
    await diskStep(this.fs.remove(stagingDirectory(this.root, id)), `remove the ${entry.record.name} partial payload`)
    entry.state = 'absent'
    entry.receivedBytes = 0
    entry.failure = null
    this.notify()
  }

  activate(id: ModelId): void {
    const chosen = this.entry(id)
    for (const entry of this.entries.values()) {
      if (entry.record.kind === chosen.record.kind) entry.active = entry === chosen
    }
    this.notify()
  }

  readiness(): ModelReadiness {
    if (!this.supported) {
      return {
        ready: false,
        asr: null,
        tts: null,
        failure: {
          code: 'unsupported-platform',
          message: `local speech models require ${SUPPORTED_PLATFORM}; this host is not supported`,
        },
      }
    }
    const asr = this.satisfying('asr')
    const tts = this.satisfying('tts')
    if (asr === null) {
      return { ready: false, asr: null, tts: tts?.record.id ?? null, failure: this.missingFailure('asr') }
    }
    if (tts === null) {
      return { ready: false, asr: asr.record.id, tts: null, failure: this.missingFailure('tts') }
    }
    return { ready: true, asr: asr.record.id, tts: tts.record.id, failure: null }
  }

  selection(): ModelSelection | null {
    const readiness = this.readiness()
    if (!readiness.ready) return null
    const asr = this.entries.get(readiness.asr)
    const tts = this.entries.get(readiness.tts)
    /* v8 ignore next 3 -- readiness names catalog ids, and every catalog id has an entry */
    if (asr === undefined || tts === undefined) return null
    const engine = asr.record.engine
    /* v8 ignore next 3 -- a recognizer entry never names the TTS engine */
    if (engine === 'kokoro') return null
    return {
      asr: { id: engine, directory: modelDirectory(this.root, asr.record.id) },
      tts: { directory: modelDirectory(this.root, tts.record.id) },
    }
  }

  /**
   * Resolve one entry or reject.
   * @param id - catalog id from a caller.
   * @returns the mutable entry.
   * @throws {ModelStoreError} with `unknown-model` for an id outside the catalog.
   */
  private entry(id: ModelId): Entry {
    const entry = this.entries.get(id)
    if (entry === undefined) {
      throw new ModelStoreError('unknown-model', `the model catalog has no entry named ${id}`)
    }
    return entry
  }

  /** Hash every directory already on disk, then publish each result. */
  private async verifyPresent(): Promise<void> {
    if (!this.supported) return
    for (const entry of this.entries.values()) {
      const directory = modelDirectory(this.root, entry.record.id)
      try {
        if (!await diskStep(this.fs.exists(directory), `read the ${entry.record.name} directory`)) continue
        entry.state = 'verifying'
        entry.failure = null
        this.notify()
        await this.verifyFiles(entry, directory)
        entry.state = 'ready'
        entry.receivedBytes = modelBytes(entry.record)
      } catch (error) {
        entry.state = 'error'
        entry.failure = failureOf(error, 'disk')
      }
      this.notify()
    }
  }

  /**
   * Verify one model directory against the catalog pins.
   * @param entry - entry whose directory to verify.
   * @param directory - finished model directory.
   * @throws {ModelStoreError} with `size-mismatch` or `hash-mismatch`.
   */
  private async verifyFiles(entry: Entry, directory: string): Promise<void> {
    for (const file of entry.record.files) {
      const path = filePath(directory, file.path)
      const size = await diskStep(this.fs.size(path), `measure ${entry.record.name} ${file.path}`)
      if (size !== file.bytes) {
        throw new ModelStoreError('size-mismatch',
          `${entry.record.name} is missing ${file.path} or holds ${String(size ?? 0)} of its ${String(file.bytes)} bytes`)
      }
      const digest = await diskStep(this.fs.hash(path), `verify ${entry.record.name} ${file.path}`)
      if (digest !== file.sha256) {
        throw new ModelStoreError('hash-mismatch', `${entry.record.name}: ${file.path} does not match its pinned SHA-256`)
      }
    }
  }

  /**
   * Run one download and publish its outcome.
   * @param entry - entry being installed.
   * @param controller - controller that cancels this download.
   * @throws the download's failure, after recording it on the entry.
   */
  private async runDownload(entry: Entry, controller: AbortController): Promise<void> {
    let failure: Error | undefined
    try {
      await downloadModel({
        record: entry.record,
        root: this.root,
        fs: this.fs,
        transport: this.transport,
        signal: controller.signal,
        onProgress: (progress) => {
          entry.receivedBytes = progress.receivedBytes
          this.notify()
        },
      })
      entry.state = 'ready'
      entry.receivedBytes = modelBytes(entry.record)
      entry.failure = null
    } catch (error) {
      /* v8 ignore next -- downloadModel rejects with an Error; the fallback only keeps the rethrow typed */
      failure = error instanceof Error ? error : new ModelStoreError('internal', reasonOf(error), { cause: error })
      if (controller.signal.aborted) await this.discardPartial(entry)
      else {
        entry.state = 'error'
        entry.failure = failureOf(error, 'disk')
      }
    } finally {
      entry.controller = undefined
      entry.run = undefined
      this.notify()
    }
    if (failure !== undefined) throw failure
  }

  /**
   * Delete the staging directory of a cancelled download.
   * @param entry - entry whose partial payload is discarded.
   */
  private async discardPartial(entry: Entry): Promise<void> {
    try {
      await this.fs.remove(stagingDirectory(this.root, entry.record.id))
      entry.state = 'absent'
      entry.receivedBytes = 0
      entry.failure = null
    } catch (error) {
      entry.state = 'error'
      entry.failure = failureOf(error, 'disk')
    }
  }

  /**
   * Pick the entry readiness should use for one kind.
   *
   * An explicitly activated entry is used only when it is ready: a missing
   * chosen model blocks the voice layer instead of silently running another.
   * @param kind - recognizer or synthesizer.
   * @returns the active ready entry, else the first ready entry in catalog order.
   */
  private satisfying(kind: ModelKind): Entry | null {
    const candidates = [...this.entries.values()].filter(entry => entry.record.kind === kind)
    const active = candidates.find(entry => entry.active)
    if (active !== undefined) return active.state === 'ready' ? active : null
    return candidates.find(entry => entry.state === 'ready') ?? null
  }

  /**
   * Describe why a kind has no usable entry.
   * @param kind - missing kind.
   * @returns the typed readiness failure naming the chosen model when one is set.
   */
  private missingFailure(kind: ModelKind): ModelFailure {
    const label = kind === 'asr' ? 'recognizer' : 'voice'
    const chosen = [...this.entries.values()].find(entry => entry.record.kind === kind && entry.active)
    if (chosen !== undefined) {
      return {
        code: 'active-model-missing',
        message: `${chosen.record.name} is selected but not installed and verified`,
      }
    }
    return {
      code: kind === 'asr' ? 'asr-missing' : 'tts-missing',
      message: `download and verify a ${label} model before voice can start`,
    }
  }

  private notify(): void {
    const views = this.list()
    for (const listener of [...this.listeners]) listener(views)
  }
}
