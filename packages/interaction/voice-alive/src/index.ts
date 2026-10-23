/**
 * Voice panel host row. The daemon lives inside the application's Host process
 * and dies with it: no companion service and no second profile. The row mounts
 * the service namespace and its conductor child; the session binding installs
 * here, and the audio state machine and inference engines attach through it.
 * @module @deepseek-ai/dsh-voice-alive
 */

import { Service, type Context, type Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { createVoiceBindingDeps } from './binding/harness.ts'
import { createVoiceBinding } from './binding/index.ts'
import type { VoiceBinding } from './binding/types.ts'
import { VoiceConductor } from './conductor/tools.ts'
import { ModelStoreError, createModelStore, registerModelRoutes, voiceModelsRoot } from './models/host/index.ts'
import type { ModelStore } from './models/host/index.ts'

export {
  CONDUCTOR_ERROR_CODES,
  VoiceConductor,
} from './conductor/tools.ts'
export type {
  ConductorBindingResult,
  ConductorBoundResult,
  ConductorCandidatesResult,
  ConductorErrorCode,
  ConductorErrorResult,
  ConductorSessionFact,
  ConductorWorkspaceFact,
  ConductorWorkspaceList,
  VoiceBindingTarget,
} from './conductor/tools.ts'
export { AsrEngineError, createAsrEngine } from './engine/asr.ts'
export type {
  AsrEngine,
  AsrEngineErrorCode,
  AsrEngineOptions,
  AsrModelId,
  AsrRequest,
  AsrResult,
  AsrStatus,
} from './engine/types.ts'
export { createTtsEngine } from './engine/tts.ts'
export { TtsError } from './engine/tts-types.ts'
export type {
  TtsChunk,
  TtsEngine,
  TtsErrorCode,
  TtsRequest,
  TtsSpawnFn,
  TtsSpawnOptions,
  TtsStatus,
  TtsWorkerProcess,
} from './engine/tts-types.ts'
export { createEngineSupervisor, SupervisorError } from './engine/supervisor.ts'
export type {
  EngineFailureCode,
  EngineHealth,
  EngineHealthStatus,
  EngineName,
  EngineSupervisor,
  ModelSelection,
  SupervisorErrorCode,
  SupervisorOptions,
} from './engine/supervisor.ts'
export {
  MODEL_CATALOG,
  MODELS_ACTION_PATH,
  MODELS_EVENTS_PATH,
  MODELS_SNAPSHOT_PATH,
  ModelStoreError,
  SUPPORTED_PLATFORM,
  catalogEntry,
  configureSupervisor,
  createModelStore,
  modelBytes,
  modelSnapshot,
  registerModelRoutes,
  requireSelection,
  voiceModelsRoot,
} from './models/host/index.ts'
export type {
  AsrCatalogEngine,
  ModelActionKind,
  ModelFailure,
  ModelFailureCode,
  ModelFile,
  ModelId,
  ModelKind,
  ModelReadiness,
  ModelRecord,
  ModelSnapshot,
  ModelState,
  ModelStore,
  ModelStoreOptions,
  ModelView,
  SupervisorPort,
} from './models/host/index.ts'
export { createVoiceBinding } from './binding/index.ts'
export type {
  BindingDeps,
  BindingRecord,
  BindingSessionStatus,
  BindingSessions,
  BindingState,
  BindingStorage,
  BindingWorkspace,
  BindingWorkspaces,
  VoiceBinding,
} from './binding/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The voice panel daemon mounted by this row. */
    voiceAlive: VoiceAliveService
  }
}

/**
 * Host service owned by the voice bundle row.
 *
 * It owns the panel's session binding for its lifetime and mounts its conductor
 * child, so the history store and the conductor read one namespace per panel
 * rather than process-global state. The audio state machine and inference
 * engines attach to this namespace as their tickets land.
 */
export class VoiceAliveService extends Service {
  static inject = ['storageDomain', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'sessionController']

  /** The conductor child's activation; awaits the four tools' registration. */
  readonly conductor: Fiber & PromiseLike<Fiber>

  /**
   * The model HTTP routes' registration scope; resolves once Connection is
   * mounted, and is disposed with it.
   */
  readonly modelEndpoints: Fiber & PromiseLike<Fiber>

  private voiceBinding: VoiceBinding | undefined
  private modelStore: ModelStore | undefined

  /**
   * Register the service as `ctx.voiceAlive`, mount its conductor tools, and
   * claim the model HTTP routes once Connection is active.
   * @param ctx - Host plugin context that owns the service lifetime.
   */
  constructor(ctx: Context) {
    super(ctx, 'voiceAlive')
    this.conductor = ctx.plugin(VoiceConductor)
    this.modelEndpoints = ctx.inject(['connection'], (scope) => {
      const disposers = registerModelRoutes(scope.connection.fetch, () => this.models)
      return async () => {
        for (const dispose of disposers) await dispose()
      }
    })
  }

  /**
   * The panel's session binding, installed once the host services this row
   * injects are active.
   * @returns the single binding instance.
   * @throws when read before installation (the injected services are absent).
   */
  get binding(): VoiceBinding {
    if (this.voiceBinding === undefined) {
      throw new Error('voice binding is not installed: the host storage, workspace, and session services are absent')
    }
    return this.voiceBinding
  }

  /**
   * The profile's model catalog store.
   *
   * Created on first read so a profile without one never pays for it. The
   * caller that serves model state awaits `initialize()` once before the first
   * snapshot, and the supervisor gate awaits it before configuring an engine.
   * @returns the single store for this profile.
   * @throws {ModelStoreError} when the process was not launched by a dsh profile.
   */
  get models(): ModelStore {
    if (this.modelStore === undefined) {
      const profile = this.ctx.get('profileContext')
      if (profile === undefined) {
        throw new ModelStoreError('state',
          'the voice model store needs a dsh profile: profileContext is absent')
      }
      this.modelStore = createModelStore({ root: voiceModelsRoot(profile.home) })
    }
    return this.modelStore
  }

  /** Install the binding and restore the stored session without failing activation on it. */
  protected async [Service.init](): Promise<void> {
    const binding = createVoiceBinding(createVoiceBindingDeps(this.ctx))
    this.voiceBinding = binding
    try {
      await binding.ensure()
    } catch (error: unknown) {
      this.ctx.logger.warn(`voice binding: startup restore failed: ${String(error)}`)
    }
  }
}

export default VoiceAliveService
