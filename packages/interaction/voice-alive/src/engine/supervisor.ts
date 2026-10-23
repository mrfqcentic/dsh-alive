/**
 * Host-side supervisor for the local ASR and TTS engines.
 *
 * The supervisor owns one engine of each kind together with the model selection
 * they hold. Every engine keeps its own serial lane, so a model swap, a restart,
 * and every job for that engine run in submission order: a swap never
 * interleaves with a transcription, and a full ASR queue never delays speech.
 *
 * A selection is applied engine by engine and is atomic per engine: an engine
 * either holds exactly the requested model, or the supervisor records it as
 * unloaded with status `error` and refuses work until the next `configure` or
 * `restart`. A failed load never keeps the previous model as a silent fallback
 * and never leaves a half-loaded engine. A crash in one engine's worker is
 * contained to that engine; both engines respawn their own worker on the next
 * job, so the other engine keeps serving and no supervisor restart is required
 * to recover. `restart` exists for forcing a clean per-engine reload.
 * @module @deepseek-ai/dsh-voice-alive/engine/supervisor
 */

import { AsrEngineError, createAsrEngine } from './asr.ts'
import { createTtsEngine } from './tts.ts'
import { TtsError } from './tts-types.ts'
import type { TtsChunk, TtsEngine, TtsErrorCode, TtsRequest } from './tts-types.ts'
import type { AsrEngine, AsrEngineErrorCode, AsrModelId, AsrRequest, AsrResult } from './types.ts'

/** Engine a supervisor operation addresses. */
export type EngineName = 'asr' | 'tts'

/**
 * Supervisor view of one engine's life cycle.
 *
 * `ready` means a configured model is resident or can be respawned on the next
 * call, so an engine that stopped its idle worker still reads `ready`. `error`
 * means the last load or job failed; the next successful job returns it to
 * `ready`.
 */
export type EngineHealthStatus = 'unloaded' | 'loading' | 'ready' | 'error' | 'shut-down'

/** Failure code reported by the ASR or TTS engine itself. */
export type EngineFailureCode = AsrEngineErrorCode | TtsErrorCode

/** Failure code the supervisor raises before or instead of calling an engine. */
export type SupervisorErrorCode =
  | 'invalid-options'
  | 'not-configured'
  | 'queue-full'
  | 'shutting-down'
  | 'load-failed'
  | 'shutdown-failed'

/** The models the supervisor should hold; `null` explicitly unloads that engine. */
export interface ModelSelection {
  /** ASR model and the verified directory holding its weights, or null to unload the recognizer. */
  readonly asr: { readonly id: AsrModelId; readonly directory: string } | null
  /** Kokoro model directory and optional default voice, or null to unload the synthesizer. */
  readonly tts: { readonly directory: string; readonly voice?: string } | null
}

/** Observable health of one engine. Every `health` read returns a fresh snapshot. */
export interface EngineHealth {
  /** Current supervisor view of the engine's life cycle. */
  readonly status: EngineHealthStatus
  /** Code of the last engine-reported failure, retained across recovery until another failure replaces it. */
  readonly lastErrorCode: EngineFailureCode | null
  /** `Date.now()` at the last successful load or completed job, or null before the first. */
  readonly lastSuccessAt: number | null
  /** `restart()` attempts that completed for this engine, including failed attempts. */
  readonly restarts: number
}

/** Construction options; production omits both engines, tests inject fakes. */
export interface SupervisorOptions {
  /** Recognizer to supervise; defaults to a new {@link createAsrEngine} instance. */
  readonly asr?: AsrEngine
  /** Synthesizer to supervise; defaults to a new {@link createTtsEngine} instance. */
  readonly tts?: TtsEngine
  /**
   * Jobs allowed to wait behind the active one, per engine; a further job rejects with
   * `queue-full`. Must be a positive integer. Default 4, the ASR engine's own default.
   */
  readonly maxQueue?: number
}

/**
 * Owns both local speech engines: model selection, serial admission, health,
 * and teardown.
 *
 * The supervisor is safe to share between the conductor and the models surface;
 * it serializes its own operations per engine rather than requiring callers to
 * coordinate.
 */
export interface EngineSupervisor {
  /**
   * Whether both engines have an applied selection, neither is loading, and
   * neither is in `error`, and the supervisor has not been shut down.
   */
  readonly ready: boolean
  /**
   * Apply one model selection to both engines.
   *
   * Both parts are attempted even when one fails. Each engine ends either
   * holding its requested model or explicitly unloaded with status `error`; a
   * failed load never restores the previous model. Rejects with `load-failed`
   * naming every engine that failed.
   * @param selection - ASR model and TTS model, or null to unload an engine.
   */
  configure(selection: ModelSelection): Promise<void>
  /**
   * Queue one utterance on the ASR engine; jobs run in submission order.
   * @param request - PCM, rate, correlation id, and optional language hint.
   * @returns the recognized text and timing.
   */
  transcribe(request: AsrRequest): Promise<AsrResult>
  /**
   * Queue one reply on the TTS engine; chunks are emitted in sentence order.
   * A cancelled reply resolves without further chunks.
   * @param request - Reply text and request identity.
   * @param onChunk - Consumer invoked once per finished WAV.
   */
  speak(request: TtsRequest, onChunk: (chunk: TtsChunk) => void): Promise<void>
  /** Drop every queued and in-flight chunk for barge-in; queued replies resolve. */
  cancelSpeech(): void
  /**
   * Unload and reload one engine from its applied selection, or leave an
   * unconfigured engine explicitly unloaded.
   * @param engine - engine to restart; the other engine is untouched.
   */
  restart(engine: EngineName): Promise<void>
  /** Current health of both engines. */
  readonly health: { readonly asr: EngineHealth; readonly tts: EngineHealth }
  /**
   * Stop both engines and settle every pending operation. Idempotent: repeated
   * calls return the same promise. Work that has not reached an engine rejects
   * with `shutting-down`; the TTS engine's in-flight reply resolves.
   */
  shutdown(): Promise<void>
}

/** Typed supervisor failure, raised before an engine reports its own error. */
export class SupervisorError extends Error {
  /**
   * @param code - stable failure category.
   * @param message - actionable description naming the engine where one applies.
   * @param options - optional original failure cause.
   */
  constructor(readonly code: SupervisorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SupervisorError'
  }
}

/** Applied ASR model; a value here never coexists with an unloaded engine. */
interface AsrSelection {
  readonly id: AsrModelId
  readonly directory: string
}

/** Applied TTS model; a value here never coexists with an unloaded engine. */
interface TtsSelection {
  readonly directory: string
  readonly voice?: string
}

/** Mutable health the supervisor keeps per engine. */
interface EngineState {
  status: EngineHealthStatus
  lastErrorCode: EngineFailureCode | null
  lastSuccessAt: number | null
  restarts: number
}

/** One admitted reply, cancellable until its chunk loop finishes. */
interface SpeakJob {
  cancelled: boolean
  waiting: boolean
}

/** Engine codes that report a caller or admission problem rather than engine health. */
const CALLER_FAILURES: ReadonlySet<string> = new Set(['input', 'invalid-input', 'cancelled', 'queue-full'])

/** Engine code used when a failure is not one of the engines' typed errors. */
const UNTYPED_FAILURE: EngineFailureCode = 'internal'

/**
 * Describe any thrown value for a diagnostic message.
 * @param error - value a rejected operation produced.
 * @returns the error message, or the value's string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the stable failure code from an engine error.
 * @param error - value a rejected operation produced.
 * @returns the engine code, or undefined when the value carries none.
 */
function failureCode(error: unknown): EngineFailureCode | undefined {
  if (error instanceof AsrEngineError) return error.code
  if (error instanceof TtsError) return error.code
  return undefined
}

/**
 * Compare two applied ASR models.
 * @param left - requested model.
 * @param right - currently applied model.
 * @returns whether both name the same recognizer and directory.
 */
function sameAsrSelection(left: AsrSelection, right: AsrSelection): boolean {
  return left.id === right.id && left.directory === right.directory
}

/**
 * Compare two applied TTS models. An omitted voice and the engine's default
 * voice are different selections because they name different load options.
 * @param left - requested model.
 * @param right - currently applied model.
 * @returns whether both name the same directory and voice option.
 */
function sameTtsSelection(left: TtsSelection, right: TtsSelection): boolean {
  return left.directory === right.directory && left.voice === right.voice
}

/**
 * Settle one cleanup step without letting it hide another engine's failure.
 * @param work - operation to await.
 * @returns null on success, or the rejection reason.
 */
async function settled(work: Promise<void>): Promise<unknown> {
  try {
    await work
    return null
  } catch (error) {
    return error
  }
}

/** Mutable supervisor implementation kept behind the interface seam. */
class EngineSupervisorImpl implements EngineSupervisor {
  private readonly asrEngine: AsrEngine
  private readonly ttsEngine: TtsEngine
  private readonly maxQueue: number
  private asrTail: Promise<void> = Promise.resolve()
  private ttsTail: Promise<void> = Promise.resolve()
  private asrSelection: AsrSelection | null = null
  private ttsSelection: TtsSelection | null = null
  private readonly asrState: EngineState = {
    status: 'unloaded', lastErrorCode: null, lastSuccessAt: null, restarts: 0,
  }

  private readonly ttsState: EngineState = {
    status: 'unloaded', lastErrorCode: null, lastSuccessAt: null, restarts: 0,
  }

  private asrWaiting = 0
  private ttsWaiting = 0
  private readonly speakJobs = new Set<SpeakJob>()
  private shutDown = false
  private shutdownResult: Promise<void> | undefined

  constructor(options: SupervisorOptions = {}) {
    const maxQueue = options.maxQueue ?? 4
    if (!Number.isInteger(maxQueue) || maxQueue < 1) {
      throw new SupervisorError('invalid-options',
        `maxQueue must be a positive integer, received ${String(maxQueue)}`)
    }
    this.maxQueue = maxQueue
    this.asrEngine = options.asr ?? createAsrEngine({ maxQueue })
    this.ttsEngine = options.tts ?? createTtsEngine()
  }

  get ready(): boolean {
    return !this.shutDown
      && this.asrSelection !== null && this.ttsSelection !== null
      && this.asrState.status === 'ready' && this.ttsState.status === 'ready'
  }

  get health(): { readonly asr: EngineHealth; readonly tts: EngineHealth } {
    return {
      asr: { ...this.asrState },
      tts: { ...this.ttsState },
    }
  }

  async configure(selection: ModelSelection): Promise<void> {
    this.assertOpen()
    const asr = selection.asr === null
      ? null
      : { id: selection.asr.id, directory: selection.asr.directory }
    const tts = selection.tts === null
      ? null
      : {
        directory: selection.tts.directory,
        ...selection.tts.voice === undefined ? {} : { voice: selection.tts.voice },
      }
    const [asrResult, ttsResult] = await Promise.allSettled([
      this.applyAsr(asr),
      this.applyTts(tts),
    ])
    this.assertOpen()
    const failures: string[] = []
    let cause: unknown
    for (const result of [asrResult, ttsResult]) {
      if (result.status === 'fulfilled') continue
      const reason: unknown = result.reason
      failures.push(describe(reason))
      cause ??= reason
    }
    if (failures.length > 0) {
      throw new SupervisorError('load-failed', failures.join('; '), { cause })
    }
  }

  async transcribe(request: AsrRequest): Promise<AsrResult> {
    this.assertConfigured('asr')
    this.admit('asr')
    return this.appendAsr(async () => {
      this.asrWaiting--
      this.assertOpen()
      try {
        const result = await this.asrEngine.transcribe(request)
        this.recordSuccess('asr')
        return result
      } catch (error) {
        if (this.shutDown) throw error
        this.recordJobFailure('asr', error)
        throw error
      }
    })
  }

  async speak(request: TtsRequest, onChunk: (chunk: TtsChunk) => void): Promise<void> {
    this.assertConfigured('tts')
    this.admit('tts')
    const job: SpeakJob = { cancelled: false, waiting: true }
    this.speakJobs.add(job)
    return this.appendTts(async () => {
      if (job.waiting) {
        job.waiting = false
        this.ttsWaiting--
      }
      if (this.isStopped(job)) {
        this.speakJobs.delete(job)
        return
      }
      try {
        await this.ttsEngine.speak(request, onChunk)
        if (!this.isStopped(job)) this.recordSuccess('tts')
      } catch (error) {
        if (this.isStopped(job)) return
        this.recordJobFailure('tts', error)
        throw error
      } finally {
        this.speakJobs.delete(job)
      }
    })
  }

  cancelSpeech(): void {
    if (this.shutDown) return
    for (const job of this.speakJobs) {
      job.cancelled = true
      if (!job.waiting) continue
      job.waiting = false
      this.ttsWaiting--
    }
    this.ttsEngine.cancel()
  }

  async restart(engine: EngineName): Promise<void> {
    this.assertOpen()
    if (engine === 'asr') await this.appendAsr(() => this.restartAsr())
    else await this.appendTts(() => this.restartTts())
  }

  shutdown(): Promise<void> {
    if (this.shutdownResult !== undefined) return this.shutdownResult
    this.shutDown = true
    this.shutdownResult = this.finishShutdown()
    return this.shutdownResult
  }

  /** Queue one task behind every task already submitted to the ASR lane. */
  private appendAsr<T>(task: () => Promise<T>): Promise<T> {
    const next = this.asrTail.then(task)
    this.asrTail = next.then(() => undefined, () => undefined)
    return next
  }

  /** Queue one task behind every task already submitted to the TTS lane. */
  private appendTts<T>(task: () => Promise<T>): Promise<T> {
    const next = this.ttsTail.then(task)
    this.ttsTail = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Reserve one waiting slot on an engine lane.
   * @param engine - lane that receives the job.
   */
  private admit(engine: EngineName): void {
    const waiting = engine === 'asr' ? this.asrWaiting : this.ttsWaiting
    if (waiting >= this.maxQueue) {
      throw new SupervisorError('queue-full',
        `${engine === 'asr' ? 'ASR' : 'TTS'} queue is full (maxQueue=${String(this.maxQueue)})`)
    }
    if (engine === 'asr') this.asrWaiting++
    else this.ttsWaiting++
  }

  /** Apply the ASR part of a selection inside the ASR lane. */
  private applyAsr(target: AsrSelection | null): Promise<void> {
    return this.appendAsr(async () => {
      this.assertOpen()
      if (target === null) {
        await this.unloadAsr()
        return
      }
      const current = this.asrSelection
      if (current !== null && sameAsrSelection(target, current) && this.asrState.status === 'ready') return
      await this.loadAsr(target)
    })
  }

  /** Apply the TTS part of a selection inside the TTS lane. */
  private applyTts(target: TtsSelection | null): Promise<void> {
    return this.appendTts(async () => {
      this.assertOpen()
      if (target === null) {
        await this.unloadTts()
        return
      }
      const current = this.ttsSelection
      if (current !== null && sameTtsSelection(target, current) && this.ttsState.status === 'ready') return
      await this.loadTts(target)
    })
  }

  private async loadAsr(target: AsrSelection): Promise<void> {
    this.asrState.status = 'loading'
    try {
      await this.asrEngine.load(target.id, target.directory)
    } catch (error) {
      const code = failureCode(error) ?? UNTYPED_FAILURE
      this.asrSelection = null
      this.asrState.status = 'error'
      this.asrState.lastErrorCode = code
      throw new SupervisorError('load-failed',
        `ASR engine could not load ${target.id} from ${target.directory} (${code}): ${describe(error)}`,
        { cause: error })
    }
    this.asrSelection = target
    this.recordSuccess('asr')
  }

  private async unloadAsr(): Promise<void> {
    try {
      await this.asrEngine.unload()
    } catch (error) {
      const code = failureCode(error) ?? UNTYPED_FAILURE
      this.asrSelection = null
      this.asrState.status = 'error'
      this.asrState.lastErrorCode = code
      throw new SupervisorError('load-failed',
        `ASR engine could not unload (${code}): ${describe(error)}`, { cause: error })
    }
    this.asrSelection = null
    this.asrState.status = 'unloaded'
  }

  private async loadTts(target: TtsSelection): Promise<void> {
    this.ttsState.status = 'loading'
    try {
      await this.ttsEngine.load(target.directory, target.voice === undefined ? {} : { voice: target.voice })
    } catch (error) {
      const code = failureCode(error) ?? UNTYPED_FAILURE
      this.ttsSelection = null
      this.ttsState.status = 'error'
      this.ttsState.lastErrorCode = code
      throw new SupervisorError('load-failed',
        `TTS engine could not load ${target.directory} (${code}): ${describe(error)}`, { cause: error })
    }
    this.ttsSelection = target
    this.recordSuccess('tts')
  }

  private async unloadTts(): Promise<void> {
    try {
      await this.ttsEngine.unload()
    } catch (error) {
      const code = failureCode(error) ?? UNTYPED_FAILURE
      this.ttsSelection = null
      this.ttsState.status = 'error'
      this.ttsState.lastErrorCode = code
      throw new SupervisorError('load-failed',
        `TTS engine could not unload (${code}): ${describe(error)}`, { cause: error })
    }
    this.ttsSelection = null
    this.ttsState.status = 'unloaded'
  }

  private async restartAsr(): Promise<void> {
    this.assertOpen()
    const target = this.asrSelection
    this.asrState.restarts++
    this.asrState.status = 'loading'
    try {
      await this.asrEngine.unload()
    } catch (error) {
      const code = failureCode(error) ?? UNTYPED_FAILURE
      this.asrSelection = null
      this.asrState.status = 'error'
      this.asrState.lastErrorCode = code
      throw new SupervisorError('load-failed',
        `ASR engine could not restart (${code}): ${describe(error)}`, { cause: error })
    }
    if (target === null) {
      this.asrState.status = 'unloaded'
      return
    }
    await this.loadAsr(target)
  }

  private async restartTts(): Promise<void> {
    this.assertOpen()
    const target = this.ttsSelection
    this.ttsState.restarts++
    this.ttsState.status = 'loading'
    try {
      await this.ttsEngine.unload()
    } catch (error) {
      const code = failureCode(error) ?? UNTYPED_FAILURE
      this.ttsSelection = null
      this.ttsState.status = 'error'
      this.ttsState.lastErrorCode = code
      throw new SupervisorError('load-failed',
        `TTS engine could not restart (${code}): ${describe(error)}`, { cause: error })
    }
    if (target === null) {
      this.ttsState.status = 'unloaded'
      return
    }
    await this.loadTts(target)
  }

  /**
   * Decide whether a reply must end without reporting engine health.
   * @param job - admitted reply.
   * @returns whether barge-in or shutdown claimed the reply.
   */
  private isStopped(job: SpeakJob): boolean {
    return job.cancelled || this.shutDown
  }

  private recordSuccess(engine: EngineName): void {
    const state = engine === 'asr' ? this.asrState : this.ttsState
    state.status = 'ready'
    state.lastSuccessAt = Date.now()
  }

  private recordJobFailure(engine: EngineName, error: unknown): void {
    const code = failureCode(error)
    if (code !== undefined && CALLER_FAILURES.has(code)) return
    const state = engine === 'asr' ? this.asrState : this.ttsState
    state.status = 'error'
    state.lastErrorCode = code ?? UNTYPED_FAILURE
  }

  private async finishShutdown(): Promise<void> {
    this.asrSelection = null
    this.ttsSelection = null
    const [asrError, ttsError] = await Promise.all([
      settled(this.stopEngine(() => this.asrEngine.unload(), () => this.asrTail)),
      settled(this.stopEngine(() => this.ttsEngine.unload(), () => this.ttsTail)),
    ])
    // A load that was in flight may have recorded its model after shutdown began.
    this.asrSelection = null
    this.ttsSelection = null
    this.asrState.status = asrError === null ? 'shut-down' : 'error'
    this.ttsState.status = ttsError === null ? 'shut-down' : 'error'
    if (asrError !== null) this.asrState.lastErrorCode = failureCode(asrError) ?? UNTYPED_FAILURE
    if (ttsError !== null) this.ttsState.lastErrorCode = failureCode(ttsError) ?? UNTYPED_FAILURE
    const failures: string[] = []
    if (asrError !== null) failures.push(`ASR engine did not stop: ${describe(asrError)}`)
    if (ttsError !== null) failures.push(`TTS engine did not stop: ${describe(ttsError)}`)
    if (failures.length > 0) throw new SupervisorError('shutdown-failed', failures.join('; '))
  }

  /**
   * Stop one engine and drain its lane.
   *
   * A model load in flight rejects `unload`; the lane settles that load first,
   * then a second `unload` releases the engine.
   * @param unload - engine unload operation.
   * @param tail - that engine's lane tail.
   */
  private async stopEngine(unload: () => Promise<void>, tail: () => Promise<void>): Promise<void> {
    try {
      await unload()
    } catch {
      // The engine refuses unload while a model load is running; wait for the
      // load to settle, then release the engine with a second attempt.
      await tail()
      await unload()
    }
    await tail()
  }

  private assertOpen(): void {
    if (this.shutDown) throw new SupervisorError('shutting-down', 'Engine supervisor is shut down')
  }

  private assertConfigured(engine: EngineName): void {
    this.assertOpen()
    const configured = engine === 'asr' ? this.asrSelection !== null : this.ttsSelection !== null
    if (!configured) {
      throw new SupervisorError('not-configured',
        `No ${engine === 'asr' ? 'ASR' : 'TTS'} model is configured`)
    }
  }
}

/**
 * Create one supervisor for the local speech engines.
 * @param options - engine overrides and the per-engine waiting-job bound.
 * @returns a supervisor that starts unconfigured and unloaded.
 */
export function createEngineSupervisor(options?: SupervisorOptions): EngineSupervisor {
  return new EngineSupervisorImpl(options)
}
